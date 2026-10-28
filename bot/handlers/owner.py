from __future__ import annotations

from typing import Any

try:
    from aiogram import F, Router
    from aiogram.filters import Command
    from aiogram.types import (
        InlineKeyboardButton,
        InlineKeyboardMarkup,
        Message,
        WebAppInfo,
    )
except ImportError:  # pragma: no cover
    Router = None


def build_router(db: Any, config: Any, scanner: Any, publisher: Any):
    if Router is None:
        raise RuntimeError("aiogram is required to run the bot")
    router = Router()
    pending_vault: set[int] = set()

    def owner(message: Message) -> bool:
        return bool(
            message.chat.type == "private"
            and message.from_user
            and message.from_user.id == config.owner_id
        )

    @router.message(Command("start"))
    async def start(message: Message):
        if not owner(message):
            return
        markup = None
        if config.web_app_url:
            markup = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(
                            text="Open playlists",
                            web_app=WebAppInfo(url=config.web_app_url),
                        )
                    ]
                ]
            )
        await message.answer("Build and publish your playlists.", reply_markup=markup)

    @router.message(Command("setvault"))
    async def setvault(message: Message):
        if not owner(message):
            return
        pending_vault.add(message.from_user.id)
        await message.answer("Forward any message from the vault channel to me.")

    @router.message(F.forward_origin)
    async def vault_forward(message: Message):
        if not owner(message) or message.from_user.id not in pending_vault:
            return
        origin = message.forward_origin
        chat = getattr(origin, "chat", None)
        if not chat:
            await message.answer("That message does not identify a channel.")
            return
        try:
            await scanner.select_vault(chat.id)
        except Exception as exc:
            await message.answer(f"Could not set the vault: {exc}")
            return
        pending_vault.discard(message.from_user.id)
        await message.answer("Vault saved; scan started. Use /scanstatus for progress.")

    @router.message(Command("scanstatus"))
    async def scanstatus(message: Message):
        if owner(message):
            s = scanner.status()
            await message.answer(
                f"Scan: {s['state']} ({s['cursor']}/{s['max']}); indexed tracks: {s['tracks']}"
                + (f"\n{s['error']}\nUse /resumescan to retry." if s["error"] else "")
            )

    @router.message(Command("rescan", "resumescan"))
    async def rescan(message: Message):
        if not owner(message):
            return
        vault = db.setting("vault_chat_id")
        if not vault:
            await message.answer("Set a vault first with /setvault.")
            return
        try:
            scanner.start(
                int(vault), rescan=message.text.split()[0].split("@")[0] == "/rescan"
            )
        except RuntimeError as exc:
            await message.answer(str(exc))
            return
        await message.answer("Scan started. Use /scanstatus for progress.")

    @router.message(Command("newplaylist"))
    async def newplaylist(message: Message):
        if not owner(message):
            return
        name = message.text.partition(" ")[2].strip()
        if not name:
            await message.answer("Usage: /newplaylist Name")
            return
        try:
            row = db.create_playlist(name)
        except Exception:
            await message.answer("That playlist name is unavailable.")
            return
        await message.answer(f"Created playlist: {row['name']}")

    @router.message(Command("list"))
    async def listing(message: Message):
        if not owner(message):
            return
        rows = db.playlists()
        await message.answer(
            "\n".join(f"{r['name']} — {r['track_count']} tracks" for r in rows)
            or "No playlists yet."
        )

    @router.message(Command("publish"))
    async def publish(message: Message):
        if not owner(message):
            return
        name = message.text.partition(" ")[2].strip()
        row = db.fetchone("SELECT id FROM playlists WHERE name=?", (name,))
        if not row:
            await message.answer("Playlist not found.")
            return
        try:
            job = await publisher.start(row["id"])
        except Exception as exc:
            await message.answer(f"Could not start publishing: {exc}")
            return
        await message.answer(f"Publishing started (job {job}).")

    @router.my_chat_member()
    async def membership(update):
        if not update.chat or update.chat.type != "channel":
            return
        member = update.new_chat_member
        status = member.status
        rights = member
        is_member = int(status not in {"left", "kicked"})
        db.execute(
            """INSERT INTO channels(chat_id,title,can_post,can_delete,is_member,updated_at) VALUES(?,?,?,?,?,datetime('now'))
            ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,can_post=excluded.can_post,can_delete=excluded.can_delete,is_member=excluded.is_member,updated_at=excluded.updated_at""",
            (
                update.chat.id,
                update.chat.title or "",
                int(bool(getattr(rights, "can_post_messages", False))),
                int(bool(getattr(rights, "can_delete_messages", False))),
                is_member,
            ),
        )

    @router.channel_post()
    async def channel_post(message):
        vault = db.setting("vault_chat_id")
        if vault and str(message.chat.id) == vault:
            scanner.index_channel_post(message)

    return router
