import asyncio
import json
from types import SimpleNamespace

import pytest
from aiogram.exceptions import (
    TelegramBadRequest,
    TelegramForbiddenError,
    TelegramNetworkError,
)
from aiogram.methods import CopyMessage, DeleteMessages, SendAudio

from bot.db.database import now_iso
from bot.services.publisher import Publisher


def previous(db, pid, chat=-1001, mid=55, date=None):
    db.execute(
        "INSERT INTO published_messages(playlist_id,chat_id,message_id,published_at) VALUES(?,?,?,?)",
        (pid, chat, mid, date or now_iso()),
    )


async def finish(publisher):
    tasks = list(publisher.tasks.values())
    await asyncio.wait_for(asyncio.gather(*tasks), timeout=3)


async def test_publish_order_and_repeat_cleanup(db, bot, playlist, tracks):
    publisher = Publisher(bot, db, delay=0)
    job = await publisher.start(playlist)
    await finish(publisher)
    assert [call.args[2] for call in bot.copy_message.await_args_list] == [1, 2, 3]
    assert [
        r["track_id"]
        for r in db.fetchall("SELECT * FROM published_messages ORDER BY id")
    ] == tracks
    assert dict(
        db.fetchone("SELECT status,progress,total,skipped FROM jobs WHERE id=?", (job,))
    ) == dict(status="done", progress=3, total=3, skipped=0)
    await publisher.start(playlist)
    await finish(publisher)
    bot.delete_messages.assert_awaited_once_with(-1001, [100, 101, 102])
    assert len(db.fetchall("SELECT * FROM published_messages")) == 3
    assert not publisher.running and not publisher.busy_channels


async def test_moved_playlist_deletes_from_recorded_channel(db, bot, playlist):
    previous(db, playlist, -1001, 99)
    db.execute("UPDATE playlists SET channel_id=-1002 WHERE id=?", (playlist,))
    publisher = Publisher(bot, db, 0)
    await publisher.start(playlist)
    await finish(publisher)
    bot.delete_messages.assert_awaited_once_with(-1001, [99])
    assert {call.args[0] for call in bot.copy_message.await_args_list} == {-1002}
    assert {call.args[0] for call in bot.get_chat_member.await_args_list} == {
        -1001,
        -1002,
    }


async def test_delete_failure_retains_tracking_and_stops_before_posting(
    db, bot, playlist
):
    previous(db, playlist, date="2020-01-01T00:00:00+00:00")
    bot.delete_messages.side_effect = TelegramBadRequest(
        method=DeleteMessages(chat_id=-1001, message_ids=[55]),
        message="message can't be deleted",
    )
    publisher = Publisher(bot, db, 0)
    job = await publisher.start(playlist)
    await finish(publisher)
    assert db.fetchone("SELECT 1 FROM published_messages WHERE message_id=55")
    bot.copy_message.assert_not_awaited()
    row = db.fetchone("SELECT * FROM jobs WHERE id=?", (job,))
    assert (
        row["status"] == "error"
        and "48 hours" in row["error"]
        and "manually" in row["error"]
    )
    # After manual removal, Telegram skips absent messages and the retry can proceed.
    bot.delete_messages.side_effect = None
    await publisher.start(playlist)
    await finish(publisher)
    assert not db.fetchone("SELECT 1 FROM published_messages WHERE message_id=55")


async def test_cleanup_batches_and_partial_failure(db, bot, playlist, no_retry_wait):
    for mid in range(201):
        previous(db, playlist, mid=mid)

    async def delete(*args):
        if bot.delete_messages.await_count > 1:
            raise ConnectionError("offline")
        return True

    bot.delete_messages.side_effect = delete
    publisher = Publisher(bot, db, 0)
    await publisher.start(playlist)
    await finish(publisher)
    assert [len(call.args[1]) for call in bot.delete_messages.await_args_list] == [
        100,
        100,
        100,
        100,
        100,
    ]
    assert len(db.fetchall("SELECT * FROM published_messages")) == 101
    bot.copy_message.assert_not_awaited()


async def test_rights_refreshed_before_deletion(db, bot, playlist):
    previous(db, playlist)
    bot.get_chat_member.return_value.can_post_messages = False
    publisher = Publisher(bot, db, 0)
    with pytest.raises(ValueError, match="administrator rights"):
        await publisher.start(playlist)
    bot.delete_messages.assert_not_awaited()
    bot.copy_message.assert_not_awaited()
    assert not publisher.running and not publisher.busy_channels
    assert (
        db.fetchone("SELECT can_post FROM channels WHERE chat_id=-1001")["can_post"]
        == 0
    )
    assert not db.fetchall("SELECT * FROM jobs")


async def test_refresh_can_recover_stale_cached_rights(db, bot, playlist):
    db.execute("UPDATE channels SET can_post=0 WHERE chat_id=-1001")
    publisher = Publisher(bot, db, 0)
    await publisher.start(playlist)
    await finish(publisher)
    assert (
        db.fetchone("SELECT can_post FROM channels WHERE chat_id=-1001")["can_post"]
        == 1
    )


async def test_destination_failure_is_error_not_missing_audio(db, bot, playlist):
    bot.copy_message.side_effect = TelegramForbiddenError(
        method=CopyMessage(chat_id=-1001, from_chat_id=-9001, message_id=1),
        message="bot was kicked",
    )
    publisher = Publisher(bot, db, 0)
    job = await publisher.start(playlist)
    await finish(publisher)
    bot.send_audio.assert_not_awaited()
    assert not db.fetchone("SELECT 1 FROM tracks WHERE missing=1")
    assert (
        db.fetchone("SELECT status FROM jobs WHERE id=?", (job,))["status"] == "error"
    )


async def test_network_timeout_does_not_duplicate_via_fallback(db, bot, playlist):
    bot.copy_message.side_effect = TelegramNetworkError(
        method=CopyMessage(chat_id=-1001, from_chat_id=-9001, message_id=1),
        message="timeout",
    )
    publisher = Publisher(bot, db, 0)
    job = await publisher.start(playlist)
    await finish(publisher)
    assert bot.copy_message.await_count == 1
    bot.send_audio.assert_not_awaited()
    assert (
        db.fetchone("SELECT status FROM jobs WHERE id=?", (job,))["status"] == "error"
    )


async def test_fallback_and_only_invalid_audio_marked_missing(
    db, bot, playlist, tracks
):
    bot.copy_message.side_effect = TelegramBadRequest(
        method=CopyMessage(chat_id=-1001, from_chat_id=-9001, message_id=1),
        message="message to copy not found",
    )
    bot.send_audio.side_effect = [
        SimpleNamespace(message_id=88),
        TelegramBadRequest(
            method=SendAudio(chat_id=-1001, audio="file-2"),
            message="wrong file identifier/http url specified",
        ),
        SimpleNamespace(message_id=89),
    ]
    db.execute("UPDATE tracks SET missing=1 WHERE id=?", (tracks[0],))
    publisher = Publisher(bot, db, 0, owner_id=7)
    job = await publisher.start(playlist)
    await finish(publisher)
    row = db.fetchone("SELECT * FROM jobs WHERE id=?", (job,))
    assert row["status"] == "done" and row["skipped"] == 1 and row["progress"] == 3
    assert json.loads(row["skipped_titles"]) == ["Red"]
    assert [r["id"] for r in db.fetchall("SELECT * FROM tracks WHERE missing=1")] == [
        tracks[1]
    ]
    assert "2 posted, 1 skipped" in bot.edit_message_text.await_args.args[0]


async def test_vault_replacement_keeps_original_track_source(db, bot, playlist):
    db.set_setting("vault_chat_id", -9002)
    publisher = Publisher(bot, db, 0)
    await publisher.start(playlist)
    await finish(publisher)
    assert {call.args[1] for call in bot.copy_message.await_args_list} == {-9001}


async def test_legacy_track_without_source_uses_file_id(db, bot, playlist):
    db.execute("UPDATE tracks SET vault_chat_id=NULL")
    publisher = Publisher(bot, db, 0)
    await publisher.start(playlist)
    await finish(publisher)
    bot.copy_message.assert_not_awaited()
    assert bot.send_audio.await_count == 3


async def test_channel_lock_covers_concurrent_preflight(db, bot, playlist, tracks):
    second = db.create_playlist("Other")["id"]
    db.execute("UPDATE playlists SET channel_id=-1001 WHERE id=?", (second,))
    db.add_track(second, tracks[0])
    entered = asyncio.Event()
    release = asyncio.Event()
    member = bot.get_chat_member.return_value

    async def permissions(*args):
        entered.set()
        await release.wait()
        return member

    bot.get_chat_member.side_effect = permissions
    publisher = Publisher(bot, db, 0)
    first = asyncio.create_task(publisher.start(playlist))
    await entered.wait()
    with pytest.raises(RuntimeError, match="already publishing"):
        await publisher.start(playlist)
    with pytest.raises(RuntimeError, match="Another playlist"):
        await publisher.start(second)
    release.set()
    await first
    await finish(publisher)


async def test_shutdown_and_recovery_preserve_partial_output(db, bot, playlist):
    publisher = Publisher(bot, db, delay=100)
    job = await publisher.start(playlist)
    await asyncio.sleep(0)
    assert len(db.fetchall("SELECT * FROM published_messages")) == 1
    await publisher.close()
    assert (
        db.fetchone("SELECT status FROM jobs WHERE id=?", (job,))["status"]
        == "interrupted"
    )
    assert len(db.fetchall("SELECT * FROM published_messages")) == 1
    assert not publisher.tasks and not publisher.running
    db.execute("UPDATE jobs SET status='running' WHERE id=?", (job,))
    recovered = Publisher(bot, db, 0)
    recovered.recover()
    assert (
        db.fetchone("SELECT status FROM jobs WHERE id=?", (job,))["status"]
        == "interrupted"
    )
    await recovered.start(playlist)
    await finish(recovered)
    bot.delete_messages.assert_awaited_once_with(-1001, [100])


async def test_cancel_before_background_task_starts(db, bot, playlist):
    publisher = Publisher(bot, db, 0)
    job = await publisher.start(playlist)
    await publisher.close()
    assert (
        db.fetchone("SELECT status FROM jobs WHERE id=?", (job,))["status"]
        == "interrupted"
    )
    assert not publisher.running


@pytest.mark.parametrize("fails", [False, True])
async def test_terminal_status_does_not_unlock_ui_before_publisher(
    db, bot, playlist, fails
):
    if fails:
        bot.copy_message.side_effect = ConnectionError("offline")
    entered, release = asyncio.Event(), asyncio.Event()

    async def final_notification(*args, **kwargs):
        entered.set()
        await release.wait()

    bot.edit_message_text.side_effect = final_notification
    publisher = Publisher(bot, db, 0, owner_id=7)
    job = await publisher.start(playlist)
    await asyncio.wait_for(entered.wait(), timeout=3)
    assert (
        db.fetchone("SELECT status FROM jobs WHERE id=?", (job,))["status"] == "running"
    )
    assert playlist in publisher.running
    release.set()
    await finish(publisher)
    assert db.fetchone("SELECT status FROM jobs WHERE id=?", (job,))["status"] == (
        "error" if fails else "done"
    )
    assert not publisher.running and not publisher.busy_channels


async def test_vault_cannot_be_publish_target_and_empty_cannot_clear_accidentally(
    db, bot, playlist
):
    publisher = Publisher(bot, db, 0)
    db.execute("UPDATE playlists SET channel_id=-9001 WHERE id=?", (playlist,))
    with pytest.raises(ValueError, match="vault"):
        await publisher.start(playlist)
    db.execute("UPDATE playlists SET channel_id=-1001 WHERE id=?", (playlist,))
    db.set_playlist_order(playlist, [])
    with pytest.raises(ValueError, match="at least one"):
        await publisher.start(playlist)
    previous(db, playlist)
    job = await publisher.start(playlist)
    await finish(publisher)
    bot.delete_messages.assert_awaited_once()
    bot.copy_message.assert_not_awaited()
    assert db.fetchone("SELECT status FROM jobs WHERE id=?", (job,))["status"] == "done"
    assert not db.fetchall("SELECT * FROM published_messages")
