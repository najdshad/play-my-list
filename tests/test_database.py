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


def test_maintenance_keeps_only_needed_tracks_and_publish_results(db, playlist, tracks):
    template = dict(db.fetchone("SELECT * FROM tracks WHERE id=?", (tracks[0],)))
    for unique, source, missing in (("unused-old", -9002, 0), ("unused-missing", -9001, 1), ("posted-old", -9002, 0)):
        tid = db.upsert_track({**template, "file_unique_id": unique, "vault_chat_id": source})
        db.execute("UPDATE tracks SET missing=? WHERE id=?", (missing, tid))
    posted = db.fetchone("SELECT id FROM tracks WHERE file_unique_id='posted-old'")["id"]
    db.execute("INSERT INTO published_messages(playlist_id,chat_id,message_id,track_id,published_at) VALUES(?,?,?,?,?)",
               (playlist, -1001, 999, posted, now_iso()))
    job_ids = []
    for status in ("done", "error", "running"):
        job_ids.append(db.execute("INSERT INTO jobs(playlist_id,status,current_track,created_at,updated_at) VALUES(?,?,?,?,?)",
                                  (playlist, status, "Snapshot", now_iso(), now_iso())).lastrowid)
    db.execute("UPDATE channels SET is_member=0 WHERE chat_id=-1002")
    db.maintain()
    assert {r["file_unique_id"] for r in db.fetchall("SELECT * FROM tracks")} == {"1", "2", "3", "posted-old"}
    assert [r["id"] for r in db.fetchall("SELECT * FROM jobs ORDER BY id")] == job_ids[1:]
    assert db.fetchone("SELECT current_track FROM jobs WHERE id=?", (job_ids[1],))[0] is None
    assert db.fetchone("SELECT current_track FROM jobs WHERE id=?", (job_ids[2],))[0] == "Snapshot"
    assert db.fetchone("SELECT 1 FROM channels WHERE chat_id=-1002") is None
    assert len(db.playlist_tracks(playlist)) == 3
    assert db.fetchone("SELECT COUNT(*) FROM published_messages")[0] == 1
    db.execute("UPDATE jobs SET status='done' WHERE id=?", (job_ids[2],))
    db.maintain()
    assert [r["id"] for r in db.fetchall("SELECT * FROM jobs")] == [job_ids[2]]


def test_confirmed_deleted_source_preserves_playlist_and_published_references(db, playlist, tracks):
    db.execute("DELETE FROM playlist_tracks WHERE track_id=?", (tracks[1],))
    db.prune_source(-9001, 1)
    db.prune_source(-9001, 2)
    assert db.fetchone("SELECT 1 FROM tracks WHERE id=?", (tracks[0],))
    assert db.fetchone("SELECT 1 FROM tracks WHERE id=?", (tracks[1],)) is None
    # An unused, available current-vault track remains part of the library.
    db.execute("DELETE FROM playlist_tracks WHERE track_id=?", (tracks[2],))
    db.maintain()
    assert db.fetchone("SELECT 1 FROM tracks WHERE id=?", (tracks[2],))


def test_database_reclaims_deleted_pages_and_truncates_wal(db):
    db.set_setting("keep", "needed")
    with db.transaction() as conn:
        conn.executemany("INSERT INTO settings VALUES(?,?)", [(f"bulk:{i}", "x" * 4096) for i in range(256)])
    db.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
    before = db.path.stat().st_size
    db.execute("DELETE FROM settings WHERE key LIKE 'bulk:%'")
    db.maintain()
    assert db.path.stat().st_size < before / 2
    assert db.fetchone("PRAGMA auto_vacuum")[0] == 2
    assert db.fetchone("PRAGMA freelist_count")[0] == 0
    assert db.setting("keep") == "needed"
    assert db.fetchone("PRAGMA integrity_check")[0] == "ok"
    wal = Path(str(db.path) + "-wal")
    assert not wal.exists() or wal.stat().st_size == 0


def test_existing_database_enables_page_reclamation_without_losing_data(tmp_path):
    target = tmp_path / "old.db"
    with sqlite3.connect(target) as conn:
        conn.executescript(Path("bot/db/schema.sql").read_text())
        conn.execute("INSERT INTO settings VALUES('keep','needed')")
        assert conn.execute("PRAGMA auto_vacuum").fetchone()[0] == 0
    db = Database(target).open()
    assert db.fetchone("PRAGMA auto_vacuum")[0] == 2
    assert db.setting("keep") == "needed"
    assert db.fetchone("PRAGMA integrity_check")[0] == "ok"
    db.close()
