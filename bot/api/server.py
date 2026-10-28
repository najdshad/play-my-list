from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any

from aiohttp import web
from aiogram.exceptions import (
    TelegramBadRequest,
    TelegramForbiddenError,
    TelegramNetworkError,
    TelegramServerError,
)

from bot.db.database import Database
from bot.services.auth import AuthError, verify_init_data

log = logging.getLogger(__name__)


class APIError(ValueError):
    def __init__(self, message: str, code: str = "invalid_input", status: int = 400):
        super().__init__(message)
        self.code, self.status = code, status


class API:
    def __init__(
        self,
        db: Database,
        bot_token: str,
        owner_id: int,
        web_root: str | Path | None = None,
        publisher: Any = None,
    ):
        self.db, self.bot_token, self.owner_id = db, bot_token, owner_id
        self.web_root = (
            Path(web_root)
            if web_root is not None
            else Path(__file__).resolve().parents[2] / "miniapp"
        )
        self.publisher = publisher

    @staticmethod
    async def _body(request: web.Request) -> dict:
        try:
            body = await request.json()
        except (ValueError, UnicodeDecodeError) as exc:
            raise APIError("Send a valid JSON object.", "invalid_json") from exc
        if not isinstance(body, dict):
            raise APIError("The request body must be a JSON object.")
        return body

    @staticmethod
    def _integer(value: Any, label: str, *, minimum: int | None = None) -> int:
        if isinstance(value, str):
            if not value.lstrip("-").isdigit():
                raise APIError(f"{label} must be an integer.")
            value = int(value)
        if (
            type(value) is not int
            or not -(2**63) <= value < 2**63
            or (minimum is not None and value < minimum)
        ):
            raise APIError(
                f"{label} must be an integer"
                + (f" of at least {minimum}." if minimum is not None else ".")
            )
        return value

    def _playlist(self, request: web.Request, *, editable: bool = False):
        pid = self._integer(request.match_info["id"], "playlist id", minimum=1)
        playlist = self.db.playlist(pid)
        if not playlist:
            raise APIError("Playlist not found.", "not_found", 404)
        if editable and self.publisher and pid in self.publisher.running:
            raise APIError(
                "Wait for publishing to finish before editing this playlist.",
                "already_running",
                409,
            )
        return playlist

    @staticmethod
    def _name(value: Any) -> str:
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= 100:
            raise APIError("Playlist name must be 1–100 characters.", "invalid_name")
        return value.strip()

    @staticmethod
    def _job(row):
        if row is None:
            return None
        job = dict(row)
        job["skipped_titles"] = json.loads(job["skipped_titles"])
        return job

    async def channels(self, request):
        rows = self.db.fetchall(
            """SELECT chat_id,title,can_post,can_delete,is_member FROM channels
            WHERE is_member=1 AND can_post=1 AND can_delete=1
            AND chat_id != COALESCE(CAST(? AS INTEGER),0) ORDER BY title""",
            (self.db.setting("vault_chat_id"),),
        )
        return web.json_response([dict(r) for r in rows])

    async def playlists(self, request):
        return web.json_response([dict(r) for r in self.db.playlists()])

    async def create_playlist(self, request):
        body = await self._body(request)
        row = self.db.create_playlist(self._name(body.get("name")))
        return web.json_response({"id": row["id"], "name": row["name"]}, status=201)

    async def playlist(self, request):
        row = self._playlist(request)
        out = dict(row)
        out["tracks"] = [dict(r) for r in self.db.playlist_tracks(row["id"])]
        out["latest_job"] = self._job(
            self.db.fetchone(
                "SELECT * FROM jobs WHERE playlist_id=? ORDER BY id DESC LIMIT 1",
                (row["id"],),
            )
        )
        out["published_count"] = self.db.fetchone(
            "SELECT COUNT(*) n FROM published_messages WHERE playlist_id=?",
            (row["id"],),
        )["n"]
        return web.json_response(out)

    async def patch_playlist(self, request):
        body = await self._body(request)
        row = self._playlist(request, editable=True)
        fields, values = [], []
        if "name" in body:
            fields.append("name=?")
            values.append(self._name(body["name"]))
        if "channel_id" in body:
            channel = body["channel_id"]
            if channel is not None:
                if type(channel) is not int or not -(2**63) <= channel < 2**63:
                    raise APIError("channel_id must be an integer or null.")
                if str(channel) == self.db.setting("vault_chat_id"):
                    raise APIError(
                        "The vault cannot be a publish channel.", "not_ready", 422
                    )
                rights = self.db.fetchone(
                    "SELECT * FROM channels WHERE chat_id=?", (channel,)
                )
                if not rights:
                    raise APIError("Channel not found.", "not_found", 404)
                if not all(
                    rights[key] for key in ("is_member", "can_post", "can_delete")
                ):
                    raise APIError(
                        "Give the bot Post Messages and Delete Messages permissions in this channel.",
                        "not_ready",
                        422,
                    )
            fields.append("channel_id=?")
            values.append(channel)
        if fields:
            self.db.execute(
                f"UPDATE playlists SET {','.join(fields)} WHERE id=?",
                (*values, row["id"]),
            )
        return web.json_response({"ok": True})

    async def delete_playlist(self, request):
        row = self._playlist(request, editable=True)
        if self.db.fetchone(
            "SELECT 1 FROM published_messages WHERE playlist_id=?", (row["id"],)
        ):
            raise APIError(
                "Remove all tracks and publish the empty playlist to clear its previous posts before deleting it.",
                "published_messages_remain",
                409,
            )
        self.db.execute("DELETE FROM playlists WHERE id=?", (row["id"],))
        return web.json_response({"ok": True})

    async def tracks(self, request):
        limit = self._integer(request.query.get("limit", 50), "limit", minimum=1)
        offset = self._integer(request.query.get("offset", 0), "offset", minimum=0)
        return web.json_response(
            [
                dict(r)
                for r in self.db.search_tracks(
                    request.query.get("q", ""), limit, offset
                )
            ]
        )

    async def add_track(self, request):
        body = await self._body(request)
        row = self._playlist(request, editable=True)
        # JSON values must be integers, never floats, booleans or numeric strings.
        track_id = body.get("track_id")
        if type(track_id) is not int or not 1 <= track_id < 2**63:
            raise APIError("track_id must be a positive integer.")
        self.db.add_track(row["id"], track_id)
        return web.json_response({"ok": True})

    async def remove_track(self, request):
        row = self._playlist(request, editable=True)
        track_id = self._integer(request.match_info["track_id"], "track id", minimum=1)
        self.db.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?",
            (row["id"], track_id),
        )
        return web.json_response({"ok": True})

    async def order(self, request):
        body = await self._body(request)
        row = self._playlist(request, editable=True)
        ids = body.get("track_ids")
        if not isinstance(ids, list) or any(type(i) is not int for i in ids):
            raise APIError("track_ids must be an array of integers.")
        current = {r["id"] for r in self.db.playlist_tracks(row["id"])}
        if len(ids) != len(set(ids)) or set(ids) != current:
            raise APIError("Order must contain the playlist tracks exactly once.")
        self.db.set_playlist_order(row["id"], ids)
        return web.json_response({"ok": True})

    async def publish(self, request):
        row = self._playlist(request)
        if not self.publisher:
            raise APIError("Publisher unavailable.", "unavailable", 503)
        try:
            job_id = await self.publisher.start(row["id"])
        except ValueError as exc:
            raise APIError(str(exc), "not_ready", 422) from exc
        except RuntimeError as exc:
            raise APIError(str(exc), "already_running", 409) from exc
        return web.json_response({"job_id": job_id}, status=202)

    async def job(self, request):
        jid = self._integer(request.match_info["job_id"], "job id", minimum=1)
        row = self.db.fetchone("SELECT * FROM jobs WHERE id=?", (jid,))
        if not row:
            raise APIError("Job not found.", "not_found", 404)
        return web.json_response(self._job(row))

    async def index(self, request):
        return web.FileResponse(self.web_root / "index.html")

    async def asset(self, request):
        return web.FileResponse(self.web_root / request.match_info["asset"])

    def app(self):
        @web.middleware
        async def errors(request, handler):
            try:
                if request.path.startswith("/api/"):
                    verify_init_data(
                        request.headers.get("X-Telegram-Init-Data", ""),
                        self.bot_token,
                        self.owner_id,
                    )
                return await handler(request)
            except AuthError as exc:
                return web.json_response(
                    {
                        "error": f"{exc}. Close this app and reopen it from the bot.",
                        "code": "unauthorized",
                    },
                    status=401,
                )
            except APIError as exc:
                return web.json_response(
                    {"error": str(exc), "code": exc.code}, status=exc.status
                )
            except LookupError as exc:
                return web.json_response(
                    {"error": str(exc), "code": "not_found"}, status=404
                )
            except sqlite3.IntegrityError as exc:
                if "UNIQUE" in str(exc):
                    return web.json_response(
                        {
                            "error": "That playlist name is already in use.",
                            "code": "duplicate",
                        },
                        status=409,
                    )
                log.exception("Database constraint failed")
                return web.json_response(
                    {
                        "error": "The change could not be saved.",
                        "code": "invalid_input",
                    },
                    status=400,
                )
            except (TelegramBadRequest, TelegramForbiddenError):
                return web.json_response(
                    {
                        "error": "Telegram refused access. Check the bot's channel permissions and retry.",
                        "code": "not_ready",
                    },
                    status=422,
                )
            except (
                TelegramNetworkError,
                TelegramServerError,
                ConnectionError,
                TimeoutError,
            ):
                return web.json_response(
                    {
                        "error": "Telegram is temporarily unavailable. Please retry.",
                        "code": "unavailable",
                    },
                    status=503,
                )
            except web.HTTPException as exc:
                if request.path.startswith("/api/"):
                    return web.json_response(
                        {"error": exc.reason, "code": "http_error"}, status=exc.status
                    )
                raise
            except Exception:
                log.exception("API request failed")
                return web.json_response(
                    {
                        "error": "An unexpected error occurred. Please retry.",
                        "code": "internal_error",
                    },
                    status=500,
                )

        app = web.Application(middlewares=[errors])
        app.add_routes(
            [
                web.get("/api/channels", self.channels),
                web.get("/api/playlists", self.playlists),
                web.post("/api/playlists", self.create_playlist),
                web.get("/api/playlists/{id}", self.playlist),
                web.patch("/api/playlists/{id}", self.patch_playlist),
                web.delete("/api/playlists/{id}", self.delete_playlist),
                web.get("/api/tracks", self.tracks),
                web.post("/api/playlists/{id}/tracks", self.add_track),
                web.delete("/api/playlists/{id}/tracks/{track_id}", self.remove_track),
                web.put("/api/playlists/{id}/order", self.order),
                web.post("/api/playlists/{id}/publish", self.publish),
                web.get("/api/jobs/{job_id}", self.job),
                web.get("/", self.index),
                web.get("/index.html", self.index),
                web.get("/{asset:app\\.js|style\\.css}", self.asset),
            ]
        )
        return app
