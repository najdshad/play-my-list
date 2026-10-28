from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._lock = threading.RLock()
        self.conn: sqlite3.Connection | None = None

    def open(self) -> "Database":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript((Path(__file__).with_name("schema.sql")).read_text())
        self.conn.execute("PRAGMA user_version=1")
        self.conn.commit()
        return self

    def close(self) -> None:
        if self.conn:
            self.conn.close()
            self.conn = None

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        if self.conn is None:
            raise RuntimeError("database is not open")
        with self._lock:
            try:
                yield self.conn
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Cursor:
        with self.transaction() as conn:
            return conn.execute(sql, params)

    def fetchone(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        with self._lock:
            if self.conn is None:
                raise RuntimeError("database is not open")
            return self.conn.execute(sql, params).fetchone()

    def fetchall(self, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self._lock:
            if self.conn is None:
                raise RuntimeError("database is not open")
            return list(self.conn.execute(sql, params).fetchall())

    def setting(self, key: str, default: str | None = None) -> str | None:
        row = self.fetchone("SELECT value FROM settings WHERE key=?", (key,))
        return row["value"] if row else default

    def set_setting(self, key: str, value: Any) -> None:
        self.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))

    def upsert_track(self, data: dict[str, Any]) -> int:
        with self.transaction() as conn:
            conn.execute("""INSERT INTO tracks(file_unique_id,file_id,vault_message_id,title,performer,file_name,duration,file_size,missing,indexed_at)
                VALUES(:file_unique_id,:file_id,:vault_message_id,:title,:performer,:file_name,:duration,:file_size,0,:indexed_at)
                ON CONFLICT(file_unique_id) DO UPDATE SET file_id=excluded.file_id, vault_message_id=excluded.vault_message_id,
                title=excluded.title, performer=excluded.performer, file_name=excluded.file_name, duration=excluded.duration,
                file_size=excluded.file_size, missing=0, indexed_at=excluded.indexed_at""", {**data, "indexed_at": data.get("indexed_at", now_iso())})
            return int(conn.execute("SELECT id FROM tracks WHERE file_unique_id=?", (data["file_unique_id"],)).fetchone()[0])

    def create_playlist(self, name: str) -> sqlite3.Row:
        name = name.strip()
        if not name or len(name) > 100:
            raise ValueError("playlist name must be 1-100 characters")
        with self.transaction() as conn:
            cur = conn.execute("INSERT INTO playlists(name,created_at) VALUES(?,?)", (name, now_iso()))
            return conn.execute("SELECT * FROM playlists WHERE id=?", (cur.lastrowid,)).fetchone()

    def playlist(self, playlist_id: int) -> sqlite3.Row | None:
        return self.fetchone("SELECT * FROM playlists WHERE id=?", (playlist_id,))

    def playlists(self) -> list[sqlite3.Row]:
        return self.fetchall("""SELECT p.*, COUNT(pt.track_id) track_count FROM playlists p
            LEFT JOIN playlist_tracks pt ON pt.playlist_id=p.id GROUP BY p.id ORDER BY p.created_at, p.id""")

    def playlist_tracks(self, playlist_id: int) -> list[sqlite3.Row]:
        return self.fetchall("""SELECT t.*, pt.position FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id
            WHERE pt.playlist_id=? ORDER BY pt.position""", (playlist_id,))

    def set_playlist_order(self, playlist_id: int, track_ids: list[int]) -> None:
        with self.transaction() as conn:
            conn.execute("DELETE FROM playlist_tracks WHERE playlist_id=?", (playlist_id,))
            conn.executemany("INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES(?,?,?)", [(playlist_id, tid, pos) for pos, tid in enumerate(track_ids)])

    def add_track(self, playlist_id: int, track_id: int) -> None:
        with self.transaction() as conn:
            if not conn.execute("SELECT 1 FROM tracks WHERE id=?", (track_id,)).fetchone():
                raise LookupError("track not found")
            if conn.execute("SELECT 1 FROM playlist_tracks WHERE playlist_id=? AND track_id=?", (playlist_id, track_id)).fetchone():
                return
            pos = conn.execute("SELECT COALESCE(MAX(position),-1)+1 FROM playlist_tracks WHERE playlist_id=?", (playlist_id,)).fetchone()[0]
            conn.execute("INSERT INTO playlist_tracks VALUES(?,?,?)", (playlist_id, track_id, pos))

    def search_tracks(self, query: str = "", limit: int = 50, offset: int = 0) -> list[sqlite3.Row]:
        limit = max(1, min(int(limit), 100)); offset = max(0, int(offset))
        q = f"%{query.strip()}%"
        return self.fetchall("""SELECT id,title,performer,file_name,duration,missing FROM tracks
            WHERE (?='' OR title LIKE ? OR performer LIKE ? OR file_name LIKE ?) ORDER BY indexed_at DESC LIMIT ? OFFSET ?""", (query.strip(), q, q, q, limit, offset))
