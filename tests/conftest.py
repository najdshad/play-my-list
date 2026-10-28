import hashlib
import hmac
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import urlencode

import pytest

from bot.db.database import Database, now_iso


def signed_init_data(owner_id=7, token="test-token", auth_date=None):
    fields = {
        "auth_date": str(int(time.time()) if auth_date is None else auth_date),
        "user": json.dumps({"id": owner_id}),
    }
    canonical = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, canonical.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


@pytest.fixture
def db(tmp_path):
    database = Database(tmp_path / "test.db").open()
    database.set_setting("vault_chat_id", -9001)
    for cid in (-1001, -1002, -9001):
        database.execute(
            "INSERT INTO channels VALUES(?,?,?,?,?,?)",
            (cid, f"Channel {cid}", 1, 1, 1, now_iso()),
        )
    yield database
    database.close()


@pytest.fixture
def tracks(db):
    return [
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
        for i, title in enumerate(("Blue", "Red", "Green"), 1)
    ]


@pytest.fixture
def playlist(db, tracks):
    pid = db.create_playlist("Road trip")["id"]
    db.execute("UPDATE playlists SET channel_id=? WHERE id=?", (-1001, pid))
    for tid in tracks:
        db.add_track(pid, tid)
    return pid


@pytest.fixture
def bot():
    fake = SimpleNamespace(id=123)
    fake.get_chat_member = AsyncMock(
        return_value=SimpleNamespace(
            status="administrator", can_post_messages=True, can_delete_messages=True
        )
    )
    fake.get_chat = AsyncMock(
        return_value=SimpleNamespace(
            id=-9001, type="channel", title="Vault", has_protected_content=False
        )
    )
    fake.delete_messages = AsyncMock(return_value=True)
    fake.delete_message = AsyncMock(return_value=True)
    fake.copy_message = AsyncMock(
        side_effect=[SimpleNamespace(message_id=i) for i in range(100, 300)]
    )
    fake.send_audio = AsyncMock(return_value=SimpleNamespace(message_id=300))
    fake.send_message = AsyncMock(return_value=SimpleNamespace(message_id=4))
    fake.edit_message_text = AsyncMock(return_value=True)
    fake.forward_message = AsyncMock(
        return_value=SimpleNamespace(message_id=8, audio=None)
    )
    return fake


@pytest.fixture
def auth():
    return {"X-Telegram-Init-Data": signed_init_data()}


@pytest.fixture
def no_retry_wait(monkeypatch):
    from bot.services import telegram

    sleeper = AsyncMock()
    monkeypatch.setattr(telegram, "asyncio", SimpleNamespace(sleep=sleeper))
    return sleeper
