from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Awaitable, Callable

from bot.db.database import Database, now_iso
from bot.services.auth import AuthError, verify_init_data

try:
    from aiohttp import web
except ImportError:  # pragma: no cover
    web = None


class API:
    def __init__(self, db: Database, bot_token: str, owner_id: int, web_root: str | Path = "miniapp", publisher: Any = None):
        self.db, self.bot_token, self.owner_id = db, bot_token, owner_id
        self.web_root = Path(web_root)
        self.publisher = publisher
        self.jobs: dict[int, asyncio.Task] = {}

    def _auth(self, request: Any) -> None:
        verify_init_data(request.headers.get("X-Telegram-Init-Data", ""), self.bot_token, self.owner_id)

    @staticmethod
    def _json(row: Any) -> dict[str, Any]:
        return dict(row)

    def _error(self, message: str, code: str, status: int = 400):
        return web.json_response({"error": message, "code": code}, status=status)

    async def channels(self, request):
        self._auth(request)
        rows = self.db.fetchall("SELECT chat_id,title,can_post,can_delete,is_member FROM channels WHERE is_member=1 AND can_post=1 AND can_delete=1 ORDER BY title")
        return web.json_response([self._json(r) for r in rows])

    async def playlists(self, request):
        self._auth(request)
        return web.json_response([self._json(r) for r in self.db.playlists()])

    async def create_playlist(self, request):
        self._auth(request)
        try:
            body = await request.json(); row = self.db.create_playlist(str(body.get("name", "")))
        except json.JSONDecodeError:
            return self._error("invalid JSON", "invalid_json")
        except ValueError as exc:
            return self._error(str(exc), "invalid_name")
        except Exception as exc:
            if "UNIQUE" in str(exc): return self._error("playlist already exists", "duplicate", 409)
            raise
        return web.json_response({"id": row["id"], "name": row["name"]}, status=201)

    async def playlist(self, request):
        self._auth(request); pid = int(request.match_info["id"])
        row = self.db.playlist(pid)
        if not row: return self._error("playlist not found", "not_found", 404)
        out = self._json(row); out["tracks"] = [self._json(r) for r in self.db.playlist_tracks(pid)]
        return web.json_response(out)

    async def patch_playlist(self, request):
        self._auth(request); pid = int(request.match_info["id"])
        if not self.db.playlist(pid): return self._error("playlist not found", "not_found", 404)
        try: body = await request.json()
        except json.JSONDecodeError: return self._error("invalid JSON", "invalid_json")
        fields, values = [], []
        if "name" in body:
            name = str(body["name"]).strip()
            if not name or len(name) > 100: return self._error("invalid name", "invalid_name")
            fields.append("name=?"); values.append(name)
        if "channel_id" in body:
            channel_id = body["channel_id"]
            if channel_id is not None and not self.db.fetchone("SELECT 1 FROM channels WHERE chat_id=?", (channel_id,)):
                return self._error("channel not found", "channel_not_found", 404)
            fields.append("channel_id=?"); values.append(channel_id)
        if fields:
            try: self.db.execute(f"UPDATE playlists SET {','.join(fields)} WHERE id=?", (*values, pid))
            except Exception as exc:
                if "UNIQUE" in str(exc): return self._error("playlist already exists", "duplicate", 409)
                raise
        return web.json_response({"ok": True})

    async def delete_playlist(self, request):
        self._auth(request); pid = int(request.match_info["id"])
        self.db.execute("DELETE FROM playlists WHERE id=?", (pid,)); return web.json_response({"ok": True})

    async def tracks(self, request):
        self._auth(request)
        q = request.query.get("q", ""); limit = request.query.get("limit", 50); offset = request.query.get("offset", 0)
        return web.json_response([self._json(r) for r in self.db.search_tracks(q, limit, offset)])

    async def add_track(self, request):
        self._auth(request); pid = int(request.match_info["id"])
        if not self.db.playlist(pid): return self._error("playlist not found", "not_found", 404)
        try: body = await request.json()
        except json.JSONDecodeError: return self._error("invalid JSON", "invalid_json")
        try: self.db.add_track(pid, int(body["track_id"]))
        except (KeyError, ValueError): return self._error("invalid track_id", "invalid_input")
        except LookupError: return self._error("track not found", "not_found", 404)
        return web.json_response({"ok": True})

    async def remove_track(self, request):
        self._auth(request); self.db.execute("DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?", (int(request.match_info["id"]), int(request.match_info["track_id"]))); return web.json_response({"ok": True})

    async def order(self, request):
        self._auth(request); pid = int(request.match_info["id"])
        try: body = await request.json()
        except json.JSONDecodeError: return self._error("invalid JSON", "invalid_json")
        ids = body.get("track_ids")
        if not isinstance(ids, list) or any(not isinstance(i, int) for i in ids): return self._error("track_ids must be an array of integers", "invalid_input")
        if not self.db.playlist(pid): return self._error("playlist not found", "not_found", 404)
        current = {r["id"] for r in self.db.playlist_tracks(pid)}
        if len(ids) != len(set(ids)) or set(ids) != current: return self._error("order must contain the playlist tracks exactly once", "invalid_input")
        self.db.set_playlist_order(pid, ids); return web.json_response({"ok": True})

    async def publish(self, request):
        self._auth(request); pid = int(request.match_info["id"])
        if not self.publisher: return self._error("publisher unavailable", "unavailable", 503)
        try: job_id = await self.publisher.start(pid)
        except ValueError as exc: return self._error(str(exc), "not_ready", 422)
        except RuntimeError: return self._error("already publishing", "already_running", 409)
        return web.json_response({"job_id": job_id}, status=202)

    async def job(self, request):
        self._auth(request); row = self.db.fetchone("SELECT id,status,progress,total,skipped,current_track,error FROM jobs WHERE id=?", (int(request.match_info["job_id"]),))
        if not row: return self._error("job not found", "not_found", 404)
        return web.json_response(self._json(row))

    def app(self):
        if web is None: raise RuntimeError("aiohttp is required to run the server")
        @web.middleware
        async def errors(request, handler):
            try:
                return await handler(request)
            except AuthError as exc:
                return web.json_response({"error": str(exc), "code": "unauthorized"}, status=401)

        app = web.Application(middlewares=[errors])
        app.add_routes([
            web.get("/api/channels", self.channels), web.get("/api/playlists", self.playlists), web.post("/api/playlists", self.create_playlist),
            web.get("/api/playlists/{id}", self.playlist), web.patch("/api/playlists/{id}", self.patch_playlist), web.delete("/api/playlists/{id}", self.delete_playlist),
            web.get("/api/tracks", self.tracks), web.post("/api/playlists/{id}/tracks", self.add_track), web.delete("/api/playlists/{id}/tracks/{track_id}", self.remove_track),
            web.put("/api/playlists/{id}/order", self.order), web.post("/api/playlists/{id}/publish", self.publish), web.get("/api/jobs/{job_id}", self.job),
            web.static("/", self.web_root, show_index=True),
        ])
        return app
