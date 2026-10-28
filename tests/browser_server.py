"""Local browser-test server: temporary data, fake Telegram, no real bot token.

Run with: python tests/browser_server.py
The test-only Telegram bridge uses a signed dummy session; production has no bypass.
"""

import asyncio
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

from aiohttp import web
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError
from aiogram.methods import CopyMessage, DeleteMessages

from bot.api.server import API
from bot.db.database import Database, now_iso
from bot.services.publisher import Publisher
from conftest import signed_init_data


class TestBot:
    id = 123
    failure = None
    message_id = 100

    def __init__(self):
        self.messages = {}

    async def get_chat_member(self, chat, user):
        return SimpleNamespace(
            status="administrator",
            can_post_messages=self.failure != "rights",
            can_delete_messages=True,
        )

    async def copy_message(self, chat, source, message):
        if self.failure == "copy":
            raise TelegramForbiddenError(
                method=CopyMessage(
                    chat_id=chat, from_chat_id=source, message_id=message
                ),
                message="Posting permission revoked",
            )
        self.message_id += 1
        self.messages[self.message_id] = (chat, source, message)
        return SimpleNamespace(message_id=self.message_id)

    async def send_audio(self, *args):
        raise AssertionError("Unexpected fallback")

    async def delete_messages(self, chat, ids):
        if self.failure == "delete":
            raise TelegramBadRequest(
                method=DeleteMessages(chat_id=chat, message_ids=ids),
                message="message can't be deleted",
            )
        for mid in ids:
            if mid in self.messages:
                assert self.messages[mid][0] == chat, "Wrong cleanup channel"
                del self.messages[mid]
        return True


async def main():
    with tempfile.TemporaryDirectory() as tmp:
        db = Database(Path(tmp) / "browser.db").open()
        db.set_setting("vault_chat_id", -9001)
        for cid, title in (
            (-9001, "Vault"),
            (-1001, "Playlist channel"),
            (-1002, "Second channel"),
        ):
            db.execute(
                "INSERT INTO channels VALUES(?,?,?,?,?,?)",
                (cid, title, 1, 1, 1, now_iso()),
            )
        for i, title in enumerate(("Blue", "Red", "Green"), 1):
            db.upsert_track(
                dict(
                    file_unique_id=str(i),
                    file_id=f"file-{i}",
                    vault_message_id=i,
                    title=title,
                    performer="Band",
                    file_name=f"{title}.mp3",
                    duration=10,
                    file_size=100,
                )
            )
        bot = TestBot()
        publisher = Publisher(bot, db, 0.6)
        api = API(db, "test-token", 7, publisher=publisher)
        app = api.app()

        async def index(request):
            return web.Response(
                text=(api.web_root / "index.html")
                .read_text()
                .replace(
                    "https://telegram.org/js/telegram-web-app.js", "/__test/telegram.js"
                ),
                content_type="text/html",
            )

        # Replace the index handler only in this explicit local test fixture.
        for route in app.router.routes():
            if route.resource.canonical in ("/", "/index.html"):
                route._handler = index

        async def telegram(request):
            noop = "function(){}"
            bridge = {"initData": signed_init_data()}
            text = (
                "window.Telegram={WebApp:"
                + json.dumps(bridge)
                + "};const t=window.Telegram.WebApp;"
            )
            text += f"t.ready=t.expand={noop};t.BackButton={{show:{noop},hide:{noop},onClick:{noop}}};"
            text += f"t.MainButton={{show:{noop},hide:{noop},enable:{noop},disable:{noop},setText:{noop},onClick:{noop}}};"
            text += f"t.HapticFeedback={{selectionChanged:{noop}}};"
            return web.Response(text=text, content_type="application/javascript")

        async def failure(request):
            data = await request.json()
            bot.failure = data.get("kind")
            return web.json_response({"ok": True})

        async def state(request):
            return web.json_response(
                {
                    "messages": bot.messages,
                    "tracked": [
                        dict(r) for r in db.fetchall("SELECT * FROM published_messages")
                    ],
                    "playlists": [dict(r) for r in db.playlists()],
                }
            )

        app.add_routes(
            [
                web.get("/__test/telegram.js", telegram),
                web.post("/__test/failure", failure),
                web.get("/__test/state", state),
            ]
        )
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", 8765).start()
        print("Browser test server ready at http://127.0.0.1:8765", flush=True)
        try:
            await asyncio.Event().wait()
        finally:
            await runner.cleanup()
            await publisher.close()
            db.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
