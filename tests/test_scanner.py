import asyncio
from types import SimpleNamespace

import pytest
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError
from aiogram.methods import ForwardMessage

from bot.services.scanner import Scanner


def forwarded(mid=8, unique="a"):
    return SimpleNamespace(
        message_id=mid,
        audio=SimpleNamespace(
            file_unique_id=unique, file_id=f"file-{unique}", title="Song"
        ),
    )


async def test_scan_gaps_and_live_upsert(db, bot):
    bot.forward_message.side_effect = [
        forwarded(),
        TelegramBadRequest(
            method=ForwardMessage(chat_id=7, from_chat_id=-9001, message_id=2),
            message="message to forward not found",
        ),
        SimpleNamespace(message_id=9, audio=None),
    ]
    scanner = Scanner(bot, db, 7, 0)
    scanner.start(-9001)
    await scanner.task
    assert scanner.status() == dict(state="done", cursor=3, max=3, error="", tracks=1)
    track = db.fetchone("SELECT * FROM tracks")
    assert track["vault_chat_id"] == -9001 and track["vault_message_id"] == 1
    message = forwarded(10)
    message.chat = SimpleNamespace(id=-9001)
    assert scanner.index_channel_post(message) == track["id"]
    assert db.fetchone("SELECT vault_message_id FROM tracks")["vault_message_id"] == 10
    assert len(db.fetchall("SELECT * FROM tracks")) == 1
    bot.delete_messages.assert_awaited_once_with(7, [8, 9])
    bot.delete_message.assert_awaited_once()  # probe only


async def test_scan_only_prunes_confirmed_deleted_sources(db, bot, tracks):
    async def forward(owner, vault, mid):
        if mid < 3:
            raise TelegramBadRequest(
                method=ForwardMessage(chat_id=owner, from_chat_id=vault, message_id=mid),
                message="message can't be forwarded" if mid == 1 else "message to forward not found",
            )
        return SimpleNamespace(message_id=103, audio=None)

    bot.forward_message.side_effect = forward
    scanner = Scanner(bot, db, 7, 0)
    scanner.start(-9001, rescan=True)
    await scanner.task
    assert [row["id"] for row in db.fetchall("SELECT id FROM tracks")] == [tracks[0]]
    assert scanner.status()["state"] == "done"


async def test_temporary_failure_retries_same_id(db, bot, no_retry_wait):
    bot.send_message.return_value.message_id = 2
    bot.forward_message.side_effect = [ConnectionError("offline"), forwarded()]
    scanner = Scanner(bot, db, 7, 0)
    scanner.start(-9001)
    await scanner.task
    assert scanner.status()["state"] == "done"
    assert [call.args[2] for call in bot.forward_message.await_args_list] == [1, 1]
    no_retry_wait.assert_awaited_once_with(1)


async def test_exhausted_failure_retains_cursor_and_resumes(db, bot, no_retry_wait):
    async def forward(owner, vault, mid):
        if mid == 2:
            raise ConnectionError("offline")
        return forwarded(unique=str(mid))

    bot.forward_message.side_effect = forward
    scanner = Scanner(bot, db, 7, 0)
    scanner.start(-9001)
    await scanner.task
    assert scanner.status()["state"] == "error"
    assert scanner.status()["cursor"] == 0
    assert "offline" in scanner.status()["error"]
    bot.forward_message.reset_mock(side_effect=True)
    bot.forward_message.side_effect = lambda *args: forwarded(unique="resumed")
    # The error notification shares send_message; reset the probe's ID explicitly.
    bot.send_message.return_value.message_id = 4
    scanner.start(-9001)
    await scanner.task
    assert [call.args[2] for call in bot.forward_message.await_args_list] == [1, 2, 3]
    assert scanner.status()["state"] == "done"


async def test_scan_cleans_each_batch_with_one_delete_call(db, bot):
    bot.forward_message.side_effect = lambda owner, vault, mid: forwarded(
        mid=100 + mid, unique=str(mid)
    )
    scanner = Scanner(bot, db, 7, 0)
    scanner.batch = 2
    scanner.start(-9001)
    await scanner.task
    assert scanner.status()["cursor"] == 3
    assert [call.args[1] for call in bot.delete_messages.await_args_list] == [
        [101, 102],
        [103],
    ]



async def test_permission_error_is_not_a_gap(db, bot):
    bot.forward_message.side_effect = TelegramForbiddenError(
        method=ForwardMessage(chat_id=7, from_chat_id=-9001, message_id=1),
        message="bot was kicked",
    )
    scanner = Scanner(bot, db, 7, 0)
    scanner.start(-9001)
    await scanner.task
    assert scanner.status()["state"] == "error"
    assert scanner.status()["cursor"] == 0
    assert "resumescan" in bot.send_message.await_args.args[1]


async def test_dm_cleanup_failure_does_not_advance_cursor(db, bot):
    bot.forward_message.side_effect = lambda *args: forwarded()
    bot.delete_messages.side_effect = RuntimeError("cannot clean up DM")
    scanner = Scanner(bot, db, 7, 0)
    scanner.start(-9001)
    await scanner.task
    assert scanner.status()["state"] == "error"
    assert scanner.status()["cursor"] == 0
    assert len(db.fetchall("SELECT * FROM tracks")) == 1


async def test_vault_validation_does_not_replace_existing_setting(db, bot):
    bot.get_chat.return_value.has_protected_content = True
    scanner = Scanner(bot, db, 7, 0)
    with pytest.raises(ValueError, match="Restrict Saving"):
        await scanner.select_vault(-9002)
    assert db.setting("vault_chat_id") == "-9001"
    bot.get_chat.return_value.has_protected_content = False
    bot.get_chat_member.return_value.can_delete_messages = False
    with pytest.raises(ValueError, match="administrator"):
        await scanner.select_vault(-9002)
    assert db.setting("vault_chat_id") == "-9001"


async def test_vault_switch_resets_cursor_and_preserves_old_sources(db, bot, playlist):
    db.set_setting("scan_cursor", 500)
    scanner = Scanner(bot, db, 7, 0)
    await scanner.select_vault(-9002)
    assert db.setting("scan_cursor") == "0"
    await scanner.task
    assert {r["vault_chat_id"] for r in db.fetchall("SELECT * FROM tracks")} == {-9001}
    assert scanner.status()["tracks"] == 0


async def test_busy_scan_cannot_mutate_vault(db, bot):
    hold = asyncio.Event()

    async def probe(*args):
        await hold.wait()
        return SimpleNamespace(message_id=1)

    bot.send_message.side_effect = probe
    scanner = Scanner(bot, db, 7, 0)
    scanner.start(-9001)
    with pytest.raises(RuntimeError, match="already running"):
        await scanner.select_vault(-9002)
    assert db.setting("vault_chat_id") == "-9001"
    await scanner.close()
    assert scanner.status()["state"] == "paused"


async def test_restart_resumes_saved_scan_and_graceful_shutdown(db, bot):
    db.set_setting("scan_state", "running")
    db.set_setting("scan_cursor", 2)
    scanner = Scanner(bot, db, 7, 0)
    scanner.resume()
    await scanner.task
    bot.forward_message.assert_awaited_once_with(7, -9001, 3)
    assert scanner.status()["state"] == "done"
    scanner.resume()
    assert scanner.task.done()
    scanner.start(-9001)
    await scanner.close()
    assert scanner.status()["state"] == "paused"


async def test_playlist_channel_cannot_become_vault(db, bot, playlist):
    scanner = Scanner(bot, db, 7, 0)
    with pytest.raises(ValueError, match="playlist publishing"):
        await scanner.select_vault(-1001)
    bot.get_chat.assert_not_awaited()
