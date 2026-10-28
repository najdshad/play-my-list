from __future__ import annotations

import os
import math
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


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
        if not owner.isdigit() or int(owner) <= 0:
            raise ValueError("OWNER_ID must be a positive integer")
        url = os.getenv("WEB_APP_URL", "").strip()
        if url and (urlparse(url).scheme != "https" or not urlparse(url).hostname):
            raise ValueError("WEB_APP_URL must be a public HTTPS URL")
        port = int(os.getenv("WEB_APP_PORT", "8080"))
        if not 1 <= port <= 65535:
            raise ValueError("WEB_APP_PORT must be between 1 and 65535")
        publish_delay = float(os.getenv("PUBLISH_DELAY_SECONDS", "3.0"))
        scan_delay = float(os.getenv("SCAN_DELAY_SECONDS", "1.0"))
        if any(
            not math.isfinite(delay) or delay < 0
            for delay in (publish_delay, scan_delay)
        ):
            raise ValueError("Scan and publish delays must be finite and non-negative")
        return cls(
            bot_token=token,
            owner_id=int(owner),
            database_path=Path(os.getenv("DATABASE_PATH", "data/playlist_bot.db")),
            web_app_url=url,
            web_app_host=os.getenv("WEB_APP_HOST", "0.0.0.0"),
            web_app_port=port,
            publish_delay_seconds=publish_delay,
            scan_delay_seconds=scan_delay,
            log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
        )
