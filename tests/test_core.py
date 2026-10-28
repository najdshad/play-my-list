import hashlib
import hmac
import json
import time
import urllib.parse

import pytest

from bot.db.database import Database
from bot.services.auth import AuthError, verify_init_data


def test_playlist_order_and_search(tmp_path):
    db = Database(tmp_path / "db.sqlite").open()
    playlist = db.create_playlist("Road trip")
    first = db.upsert_track({"file_unique_id": "a", "file_id": "fa", "vault_message_id": 1, "title": "Blue", "performer": "Band", "file_name": "blue.mp3", "duration": 10, "file_size": 1})
    second = db.upsert_track({"file_unique_id": "b", "file_id": "fb", "vault_message_id": 2, "title": "Red", "performer": "Band", "file_name": "red.mp3", "duration": 20, "file_size": 2})
    db.add_track(playlist["id"], first); db.add_track(playlist["id"], second)
    db.set_playlist_order(playlist["id"], [second, first])
    assert [row["id"] for row in db.playlist_tracks(playlist["id"])] == [second, first]
    assert db.search_tracks("blue")[0]["id"] == first


def test_init_data_authentication():
    fields = {"auth_date": str(int(time.time())), "user": json.dumps({"id": 7}, separators=(",", ":"))}
    canonical = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
    secret = hmac.new(b"WebAppData", b"token", hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, canonical.encode(), hashlib.sha256).hexdigest()
    raw = urllib.parse.urlencode(fields)
    assert verify_init_data(raw, "token", 7)["user_id"] == "7"
    with pytest.raises(AuthError): verify_init_data(raw, "wrong", 7)
