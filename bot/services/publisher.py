from __future__ import annotations

import asyncio
import logging
from typing import Any

from bot.db.database import Database, now_iso
from bot.services.telegram import retry_telegram

log = logging.getLogger(__name__)


class Publisher:
    def __init__(self, bot: Any, db: Database, delay: float = 3.0):
        self.bot, self.db, self.delay = bot, db, delay
        self.running: set[int] = set()

    async def start(self, playlist_id: int) -> int:
        if playlist_id in self.running: raise RuntimeError("already publishing")
        playlist = self.db.playlist(playlist_id)
        if not playlist or playlist["channel_id"] is None: raise ValueError("playlist needs a channel")
        channel = self.db.fetchone("SELECT * FROM channels WHERE chat_id=? AND is_member=1 AND can_post=1 AND can_delete=1", (playlist["channel_id"],))
        if not channel: raise ValueError("channel is unavailable")
        tracks = self.db.playlist_tracks(playlist_id)
        with self.db.transaction() as conn:
            cur = conn.execute("INSERT INTO jobs(playlist_id,status,total,created_at,updated_at) VALUES(?,?,?,?,?)", (playlist_id, "running", len(tracks), now_iso(), now_iso()))
            job_id = int(cur.lastrowid)
        self.running.add(playlist_id)
        asyncio.create_task(self._run(job_id, playlist, tracks))
        return job_id

    async def _run(self, job_id: int, playlist: Any, tracks: list[Any]) -> None:
        pid, chat_id = playlist["id"], playlist["channel_id"]
        try:
            old = self.db.fetchall("SELECT id,message_id FROM published_messages WHERE playlist_id=?", (pid,))
            for i in range(0, len(old), 100):
                batch = old[i:i + 100]
                try:
                    delete_many = getattr(self.bot, "delete_messages")
                    await retry_telegram(delete_many, chat_id, [row["message_id"] for row in batch])
                except AttributeError:
                    for row in batch:
                        try: await retry_telegram(self.bot.delete_message, chat_id, row["message_id"])
                        except Exception: log.debug("could not delete old message %s", row["message_id"])
                except Exception:
                    log.debug("could not delete a batch of old messages")
                self.db.execute("DELETE FROM published_messages WHERE playlist_id=? AND id IN (%s)" % ",".join("?" * len(batch)), (pid, *[r["id"] for r in batch]))
            skipped = 0
            for index, track in enumerate(tracks, 1):
                self.db.execute("UPDATE jobs SET progress=?,current_track=?,updated_at=? WHERE id=?", (index - 1, track["title"] or track["file_name"] or "Untitled", now_iso(), job_id))
                try:
                    msg = await retry_telegram(self.bot.copy_message, chat_id, int(self.db.setting("vault_chat_id")), track["vault_message_id"])
                except Exception:
                    try: msg = await retry_telegram(self.bot.send_audio, chat_id, track["file_id"])
                    except Exception:
                        skipped += 1
                        self.db.execute("UPDATE tracks SET missing=1 WHERE id=?", (track["id"],)); continue
                self.db.execute("INSERT INTO published_messages(playlist_id,chat_id,message_id,track_id,published_at) VALUES(?,?,?,?,?)", (pid, chat_id, msg.message_id, track["id"], now_iso()))
                await asyncio.sleep(self.delay)
            self.db.execute("UPDATE jobs SET status='done',progress=?,skipped=?,updated_at=? WHERE id=?", (len(tracks), skipped, now_iso(), job_id))
            self.db.execute("UPDATE playlists SET last_published_at=? WHERE id=?", (now_iso(), pid))
        except Exception as exc:
            log.exception("publish failed")
            self.db.execute("UPDATE jobs SET status='error',error=?,updated_at=? WHERE id=?", (str(exc), now_iso(), job_id))
        finally:
            self.running.discard(pid)
