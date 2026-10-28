from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from aiogram.exceptions import TelegramNetworkError, TelegramServerError

from bot.db.database import Database, now_iso
from bot.services.telegram import (
    check_channel_rights,
    copy_source_unavailable,
    invalid_audio,
    retry_telegram,
)

log = logging.getLogger(__name__)


class Publisher:
    def __init__(
        self, bot: Any, db: Database, delay: float = 3.0, owner_id: int | None = None
    ):
        self.bot, self.db, self.delay, self.owner_id = bot, db, delay, owner_id
        self.running: set[int] = set()
        self.busy_channels: set[int] = set()
        self.tasks: dict[int, asyncio.Task] = {}
        self.closing = False

    def recover(self) -> None:
        self.db.execute(
            """UPDATE jobs SET status='interrupted',
            error='The process stopped. Publish again to clean up tracked partial output.',
            updated_at=? WHERE status='running'""",
            (now_iso(),),
        )

    async def close(self) -> None:
        self.closing = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.recover()
        self.tasks.clear()
        self.running.clear()
        self.busy_channels.clear()

    async def start(self, playlist_id: int) -> int:
        if self.closing:
            raise RuntimeError("The bot is shutting down. Try again shortly.")
        if playlist_id in self.running:
            raise RuntimeError("This playlist is already publishing.")
        playlist = self.db.playlist(playlist_id)
        if not playlist:
            raise LookupError("Playlist not found.")
        chat_id = playlist["channel_id"]
        if chat_id is None:
            raise ValueError("Choose a playlist channel first.")
        tracks = self.db.playlist_tracks(playlist_id)
        if str(chat_id) == self.db.setting("vault_chat_id") or any(
            t["vault_chat_id"] == chat_id for t in tracks
        ):
            raise ValueError("A vault channel cannot be used as the publish channel.")
        old = self.db.fetchall(
            "SELECT * FROM published_messages WHERE playlist_id=? ORDER BY id",
            (playlist_id,),
        )
        if not tracks and not old:
            raise ValueError("Add at least one track before publishing.")
        channels = {chat_id, *(r["chat_id"] for r in old)}
        if channels & self.busy_channels:
            raise RuntimeError(
                "Another playlist is publishing to one of these channels. Wait for it to finish."
            )
        # Reserve before the first await so concurrent starts cannot pass preflight.
        self.running.add(playlist_id)
        self.busy_channels.update(channels)
        try:
            for channel in sorted(channels):
                await check_channel_rights(
                    self.bot, self.db, channel, post=channel == chat_id
                )
            with self.db.transaction() as conn:
                cur = conn.execute(
                    "INSERT INTO jobs(playlist_id,status,total,created_at,updated_at) VALUES(?,?,?,?,?)",
                    (playlist_id, "running", len(tracks), now_iso(), now_iso()),
                )
                job_id = int(cur.lastrowid)
            self.tasks[playlist_id] = asyncio.create_task(
                self._run(job_id, playlist, tracks, old, channels)
            )
            return job_id
        except BaseException:
            self.running.discard(playlist_id)
            self.busy_channels.difference_update(channels)
            raise

    async def _clear(self, old: list[Any]) -> None:
        groups: dict[int, list[Any]] = defaultdict(list)
        for row in old:
            groups[row["chat_id"]].append(row)
        for chat_id, rows in groups.items():
            for offset in range(0, len(rows), 100):
                batch = rows[offset : offset + 100]
                try:
                    await retry_telegram(
                        self.bot.delete_messages,
                        chat_id,
                        [r["message_id"] for r in batch],
                        retry_transient=True,
                    )
                except Exception as exc:
                    # Never forget messages Telegram did not confirm deleting.
                    raise RuntimeError(
                        f"Could not clear previous posts in channel {chat_id}. "
                        "Telegram normally allows deletion only within 48 hours. "
                        "Check Delete Messages permission; if the posts are too old, "
                        "delete them manually in Telegram, then publish again. "
                        "Their tracking has been retained."
                    ) from exc
                self.db.execute(
                    "DELETE FROM published_messages WHERE id IN (%s)"
                    % ",".join("?" for _ in batch),
                    tuple(r["id"] for r in batch),
                )

    async def _send(self, chat_id: int, track: Any) -> Any:
        if track["vault_chat_id"] is not None:
            try:
                return await retry_telegram(
                    self.bot.copy_message,
                    chat_id,
                    track["vault_chat_id"],
                    track["vault_message_id"],
                )
            except Exception as exc:
                if not copy_source_unavailable(exc):
                    raise
        # Only a confirmed source error permits a fallback. A timeout is ambiguous.
        return await retry_telegram(self.bot.send_audio, chat_id, track["file_id"])

    async def _notify(self, text: str, message_id: int | None = None) -> int | None:
        if self.owner_id is None:
            return None
        try:
            if message_id is not None:
                await retry_telegram(
                    self.bot.edit_message_text,
                    text,
                    chat_id=self.owner_id,
                    message_id=message_id,
                )
                return message_id
            result = await retry_telegram(self.bot.send_message, self.owner_id, text)
            return result.message_id
        except Exception:
            log.warning("Could not deliver publish notification", exc_info=True)
            return message_id

    async def _run(
        self,
        job_id: int,
        playlist: Any,
        tracks: list[Any],
        old: list[Any],
        channels: set[int],
    ) -> None:
        pid, chat_id = playlist["id"], playlist["channel_id"]
        skipped: list[str] = []
        posted = 0
        notice = None
        try:
            notice = await self._notify(
                f"Publishing {playlist['name']}: 0/{len(tracks)}"
            )
            await self._clear(old)
            for index, track in enumerate(tracks, 1):
                title = track["title"] or track["file_name"] or "Untitled"
                self.db.execute(
                    "UPDATE jobs SET current_track=?,updated_at=? WHERE id=?",
                    (title, now_iso(), job_id),
                )
                try:
                    msg = await self._send(chat_id, track)
                except Exception as exc:
                    if not invalid_audio(exc):
                        raise
                    skipped.append(title)
                    self.db.execute(
                        "UPDATE tracks SET missing=1 WHERE id=?", (track["id"],)
                    )
                else:
                    # No await between receiving the message ID and persisting it.
                    self.db.execute(
                        "INSERT INTO published_messages(playlist_id,chat_id,message_id,track_id,published_at) VALUES(?,?,?,?,?)",
                        (pid, chat_id, msg.message_id, track["id"], now_iso()),
                    )
                    self.db.execute(
                        "UPDATE tracks SET missing=0 WHERE id=?", (track["id"],)
                    )
                    posted += 1
                self.db.execute(
                    "UPDATE jobs SET progress=?,skipped=?,skipped_titles=?,updated_at=? WHERE id=?",
                    (index, len(skipped), json.dumps(skipped), now_iso(), job_id),
                )
                if index % 10 == 0 and index < len(tracks):
                    notice = await self._notify(
                        f"Publishing {playlist['name']}: {index}/{len(tracks)}, skipped {len(skipped)}",
                        notice,
                    )
                await asyncio.sleep(self.delay)
            if posted:
                self.db.execute(
                    "UPDATE playlists SET last_published_at=? WHERE id=?",
                    (now_iso(), pid),
                )
            summary = f"Published {playlist['name']}: {posted} posted, {len(skipped)} skipped."
            if skipped:
                summary += "\nSkipped: " + ", ".join(skipped)
            await self._notify(summary[:4000], notice)
            self.db.execute(
                "UPDATE jobs SET status='done',current_track=NULL,updated_at=? WHERE id=?",
                (now_iso(), job_id),
            )
        except asyncio.CancelledError:
            self.db.execute(
                "UPDATE jobs SET status='interrupted',error=?,updated_at=? WHERE id=?",
                (
                    "Publishing was interrupted. Publish again to clean up tracked partial output.",
                    now_iso(),
                    job_id,
                ),
            )
            raise
        except Exception as exc:
            log.exception("Publish failed")
            error = str(exc)
            if isinstance(
                exc,
                (
                    TelegramNetworkError,
                    TelegramServerError,
                    ConnectionError,
                    TimeoutError,
                ),
            ):
                error += " Telegram may have accepted the current post. Inspect the channel for an extra post before retrying."
            await self._notify(
                f"Publishing {playlist['name']} failed: {error}"[:4000], notice
            )
            self.db.execute(
                "UPDATE jobs SET status='error',error=?,updated_at=? WHERE id=?",
                (error, now_iso(), job_id),
            )
        finally:
            self.running.discard(pid)
            self.busy_channels.difference_update(channels)
            self.tasks.pop(pid, None)
