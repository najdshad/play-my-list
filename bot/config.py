from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    bot_token: str
    owner_id: int
    database_path: Path
    web_app_url: str
    web_app_host: str = "0.0.0.0"
    web_app_port: int = 8080
    publish_delay_seconds: float = 3.0
    scan_delay_seconds: float = 1.0
    log_level: str = "INFO"

    @classmethod
    def from_env(cls) -> "Config":
        token = os.getenv("BOT_TOKEN", "").strip()
        owner = os.getenv("OWNER_ID", "").strip()
        if not token:
            raise ValueError("BOT_TOKEN is required")
        if not owner or not owner.lstrip("-").isdigit():
            raise ValueError("OWNER_ID must be an integer")
        return cls(
            bot_token=token,
            owner_id=int(owner),
            database_path=Path(os.getenv("DATABASE_PATH", "data/playlist_bot.db")),
            web_app_url=os.getenv("WEB_APP_URL", "").strip(),
            web_app_host=os.getenv("WEB_APP_HOST", "0.0.0.0"),
            web_app_port=int(os.getenv("WEB_APP_PORT", "8080")),
            publish_delay_seconds=float(os.getenv("PUBLISH_DELAY_SECONDS", "3.0")),
            scan_delay_seconds=float(os.getenv("SCAN_DELAY_SECONDS", "1.0")),
            log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
        )
