import sqlite3
from pathlib import Path

import pytest

from bot.db.database import Database, now_iso


def test_v1_migration_preserves_playlists_sources_and_tracking(tmp_path):
    path = tmp_path / "legacy.db"
    old_schema = (
        Path("bot/db/schema.sql")
        .read_text()
        .replace("  vault_chat_id INTEGER,\n", "")
        .replace("  skipped_titles TEXT NOT NULL DEFAULT '[]',\n", "")
    )
    with sqlite3.connect(path) as conn:
        conn.executescript(old_schema)
        conn.execute("PRAGMA user_version=1")
        conn.execute("INSERT INTO settings VALUES('vault_chat_id','-9001')")
        conn.execute(
            "INSERT INTO tracks(file_unique_id,file_id,vault_message_id,title,indexed_at) VALUES('a','file-a',4,'Song',?)",
            (now_iso(),),
        )
        conn.execute(
            "INSERT INTO playlists(name,created_at) VALUES('Old',?)", (now_iso(),)
        )
        conn.execute("INSERT INTO playlist_tracks VALUES(1,1,0)")
        conn.execute(
            "INSERT INTO published_messages(playlist_id,chat_id,message_id,published_at) VALUES(1,-1001,55,?)",
            (now_iso(),),
        )
        conn.execute(
            "INSERT INTO jobs(playlist_id,status,created_at,updated_at) VALUES(1,'running',?,?)",
            (now_iso(), now_iso()),
        )
    db = Database(path).open()
    assert db.fetchone("PRAGMA user_version")[0] == 2
    assert db.playlist_tracks(1)[0]["vault_chat_id"] is None
    assert db.playlist_tracks(1)[0]["file_id"] == "file-a"
    assert db.fetchone("SELECT message_id FROM published_messages")["message_id"] == 55
    assert db.fetchone("SELECT skipped_titles FROM jobs")["skipped_titles"] == "[]"
    db.set_setting("vault_chat_id", -9002)
    db.close()
    db.open()
    assert db.playlist_tracks(1)[0]["vault_chat_id"] is None
    assert db.fetchone("PRAGMA integrity_check")[0] == "ok"
    db.close()


def test_reorder_transaction_rolls_back_on_invalid_tracks(db, playlist, tracks):
    with pytest.raises(sqlite3.IntegrityError):
        db.set_playlist_order(playlist, [tracks[0], tracks[0]])
    assert [r["id"] for r in db.playlist_tracks(playlist)] == tracks


def test_source_scoped_search_does_not_mix_vaults(db, tracks):
    db.set_setting("vault_chat_id", -9002)
    assert db.search_tracks("Blue") == []
    assert (
        db.fetchone("SELECT vault_chat_id FROM tracks WHERE id=?", (tracks[0],))[
            "vault_chat_id"
        ]
        == -9001
    )


def test_future_schema_is_not_downgraded(tmp_path):
    path = tmp_path / "future.db"
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA user_version=99")
    with pytest.raises(RuntimeError, match="newer version"):
        Database(path).open()
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 99
