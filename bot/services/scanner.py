from __future__ import annotations

import asyncio
import logging
from typing import Any

from bot.db.database import Database, now_iso
from bot.services.telegram import check_channel_rights, retry_telegram, scan_gap

log = logging.getLogger(__name__)


class Scanner:
    def __init__(self, bot: Any, db: Database, owner_id: int, delay: float = 1.0):
        self.bot, self.db, self.owner_id, self.delay = bot, db, owner_id, delay
        self.task: asyncio.Task | None = None

    async def select_vault(self, chat_id: int) -> None:
        if self.task and not self.task.done():
            raise RuntimeError(
                "A scan is already running. Wait for it to finish before changing the vault."
            )
        if self.db.fetchone(
            "SELECT 1 FROM playlists WHERE channel_id=?", (chat_id,)
        ) or self.db.fetchone(
            "SELECT 1 FROM published_messages WHERE chat_id=?", (chat_id,)
        ):
            raise ValueError(
                "Choose a channel that is not used for playlist publishing."
            )
        chat = await retry_telegram(self.bot.get_chat, chat_id, retry_transient=True)
        if chat.type != "channel":
            raise ValueError("The vault must be a channel.")
        if getattr(chat, "has_protected_content", False):
            raise ValueError(
                "Turn off Restrict Saving Content in the vault before scanning."
            )
        await check_channel_rights(self.bot, self.db, chat_id)
        self.db.execute(
            """INSERT INTO channels VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id)
            DO UPDATE SET title=excluded.title,can_post=1,can_delete=1,is_member=1,updated_at=excluded.updated_at""",
            (chat_id, chat.title or "", 1, 1, 1, now_iso()),
        )
        self.start(chat_id, rescan=True)

    def start(self, vault_chat_id: int, rescan: bool = False) -> None:
        if self.task and not self.task.done():
            raise RuntimeError("A scan is already running.")
        if rescan or self.db.setting("vault_chat_id") != str(vault_chat_id):
            self.db.set_setting("scan_cursor", 0)
        self.db.set_setting("vault_chat_id", vault_chat_id)
        self.db.set_setting("scan_state", "running")
        self.db.set_setting("scan_error", "")
        self.task = asyncio.create_task(self.run(vault_chat_id))

    def resume(self) -> None:
        vault = self.db.setting("vault_chat_id")
        if vault and self.db.setting("scan_state") in {"running", "paused"}:
            self.start(int(vault))

    async def close(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            # Also handles cancellation before run() ever started.
            if self.db.setting("scan_state") == "running":
                self.db.set_setting("scan_state", "paused")

    async def run(self, vault_chat_id: int) -> None:
        self.db.set_setting("scan_state", "running")
        try:
            probe = await retry_telegram(
                self.bot.send_message, vault_chat_id, "Scanning…"
            )
            max_id = int(probe.message_id)
            await retry_telegram(
                self.bot.delete_message,
                vault_chat_id,
                probe.message_id,
                retry_transient=True,
            )
            self.db.set_setting("scan_max_id", max_id - 1)
            cursor = int(self.db.setting("scan_cursor", "0") or 0)
            for message_id in range(cursor + 1, max_id):
                try:
                    forwarded = await retry_telegram(
                        self.bot.forward_message,
                        self.owner_id,
                        vault_chat_id,
                        message_id,
                        retry_transient=True,
                    )
                except Exception as exc:
                    if not scan_gap(exc):
                        raise
                    log.debug("Scan gap at %s: %s", message_id, exc)
                else:
                    try:
                        self.index_channel_post(
                            forwarded,
                            vault_chat_id=vault_chat_id,
                            message_id=message_id,
                        )
                    finally:
                        await retry_telegram(
                            self.bot.delete_message,
                            self.owner_id,
                            forwarded.message_id,
                            retry_transient=True,
                        )
                self.db.set_setting("scan_cursor", message_id)
                await asyncio.sleep(self.delay)
            self.db.set_setting("scan_state", "done")
            self.db.set_setting("scan_error", "")
        except asyncio.CancelledError:
            self.db.set_setting("scan_state", "paused")
            raise
        except Exception as exc:
            log.exception("Vault scan failed")
            self.db.set_setting("scan_state", "error")
            self.db.set_setting("scan_error", str(exc))
            try:
                await retry_telegram(
                    self.bot.send_message,
                    self.owner_id,
                    f"Vault scan stopped: {exc}. Progress was saved. Use /resumescan to retry."[
                        :4000
                    ],
                )
            except Exception:
                log.warning("Could not deliver scan error notification", exc_info=True)

    def status(self) -> dict[str, Any]:
        vault = self.db.setting("vault_chat_id")
        return {
            "state": self.db.setting("scan_state", "idle"),
            "cursor": int(self.db.setting("scan_cursor", "0") or 0),
            "max": int(self.db.setting("scan_max_id", "0") or 0),
            "error": self.db.setting("scan_error", ""),
            "tracks": self.db.fetchone(
                "SELECT COUNT(*) n FROM tracks WHERE vault_chat_id=CAST(? AS INTEGER)",
                (vault,),
            )["n"],
        }

    def index_channel_post(
        self,
        message: Any,
        *,
        vault_chat_id: int | None = None,
        message_id: int | None = None,
    ) -> int | None:
        audio = getattr(message, "audio", None)
        if not audio:
            return None
        return self.db.upsert_track(
            {
                "file_unique_id": audio.file_unique_id,
                "file_id": audio.file_id,
                "vault_chat_id": vault_chat_id
                if vault_chat_id is not None
                else message.chat.id,
                "vault_message_id": message_id
                if message_id is not None
                else message.message_id,
                "title": getattr(audio, "title", None),
                "performer": getattr(audio, "performer", None),
                "file_name": getattr(audio, "file_name", None),
                "duration": getattr(audio, "duration", 0) or 0,
                "file_size": getattr(audio, "file_size", 0) or 0,
            }
        )
