from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable


async def retry_telegram(call: Callable[..., Awaitable[Any]], *args: Any, **kwargs: Any) -> Any:
    """Retry Bot API calls when Telegram explicitly supplies retry_after."""
    while True:
        try:
            return await call(*args, **kwargs)
        except Exception as exc:
            wait = getattr(exc, "retry_after", None)
            if wait is None:
                raise
            seconds = getattr(wait, "timeout", wait)
            await asyncio.sleep(float(seconds))
