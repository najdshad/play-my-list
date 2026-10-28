from __future__ import annotations

import asyncio
import logging
from typing import Any

from bot.db.database import Database
from bot.services.telegram import retry_telegram

log = logging.getLogger(__name__)


class Scanner:
    def __init__(self, bot: Any, db: Database, owner_id: int, delay: float = 1.0):
        self.bot, self.db, self.owner_id, self.delay = bot, db, owner_id, delay
        self.task: asyncio.Task | None = None

    def start(self, vault_chat_id: int, rescan: bool = False) -> None:
        if self.task and not self.task.done():
            return
        if rescan:
            self.db.set_setting("scan_cursor", 0)
        self.db.set_setting("vault_chat_id", vault_chat_id)
        self.task = asyncio.create_task(self.run(vault_chat_id))

    async def run(self, vault_chat_id: int) -> None:
        self.db.set_setting("scan_state", "running")
        try:
            probe = await retry_telegram(self.bot.send_message, vault_chat_id, "Scanning…")
            max_id = int(probe.message_id)
            await retry_telegram(self.bot.delete_message, vault_chat_id, probe.message_id)
            self.db.set_setting("scan_max_id", max_id)
            cursor = int(self.db.setting("scan_cursor", "0") or 0)
            for message_id in range(cursor + 1, max_id):
                try:
                    forwarded = await retry_telegram(self.bot.forward_message, self.owner_id, vault_chat_id, message_id)
                    audio = getattr(forwarded, "audio", None)
                    if audio:
                        self.db.upsert_track({
                            "file_unique_id": audio.file_unique_id, "file_id": audio.file_id, "vault_message_id": message_id,
                            "title": getattr(audio, "title", None), "performer": getattr(audio, "performer", None),
                            "file_name": getattr(audio, "file_name", None), "duration": getattr(audio, "duration", 0) or 0,
                            "file_size": getattr(audio, "file_size", 0) or 0,
                        })
                    await retry_telegram(self.bot.delete_message, self.owner_id, forwarded.message_id)
                except Exception as exc:
                    log.debug("scan gap at %s: %s", message_id, exc)
                self.db.set_setting("scan_cursor", message_id)
                await asyncio.sleep(self.delay)
            self.db.set_setting("scan_state", "done")
        except asyncio.CancelledError:
            self.db.set_setting("scan_state", "idle")
            raise
        except Exception:
            log.exception("vault scan failed")
            self.db.set_setting("scan_state", "error")

    def status(self) -> dict[str, Any]:
        return {
            "state": self.db.setting("scan_state", "idle"),
            "cursor": int(self.db.setting("scan_cursor", "0") or 0),
            "max": int(self.db.setting("scan_max_id", "0") or 0),
            "tracks": self.db.fetchone("SELECT COUNT(*) n FROM tracks")["n"],
        }

    def index_channel_post(self, message: Any) -> int | None:
        audio = getattr(message, "audio", None)
        if not audio: return None
        return self.db.upsert_track({
            "file_unique_id": audio.file_unique_id, "file_id": audio.file_id, "vault_message_id": message.message_id,
            "title": getattr(audio, "title", None), "performer": getattr(audio, "performer", None),
            "file_name": getattr(audio, "file_name", None), "duration": getattr(audio, "duration", 0) or 0,
            "file_size": getattr(audio, "file_size", 0) or 0,
        })
