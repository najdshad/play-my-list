from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from aiogram.exceptions import (
    TelegramBadRequest,
    TelegramNetworkError,
    TelegramServerError,
)

from bot.db.database import Database, now_iso


async def retry_telegram(
    call: Callable[..., Awaitable[Any]],
    *args: Any,
    retry_transient: bool = False,
    **kwargs: Any,
) -> Any:
    """Honor flood waits; retry temporary failures only for safe operations.

    A send/copy timeout may mean Telegram accepted the message. Retrying it (or
    falling back to another send) can duplicate output, so sends opt out.
    """
    attempts = 0
    while True:
        try:
            return await call(*args, **kwargs)
        except Exception as exc:
            wait = getattr(exc, "retry_after", None)
            if wait is not None:
                await asyncio.sleep(float(getattr(wait, "timeout", wait)))
            elif (
                retry_transient
                and isinstance(
                    exc,
                    (
                        TelegramNetworkError,
                        TelegramServerError,
                        ConnectionError,
                        TimeoutError,
                    ),
                )
                and attempts < 3
            ):
                await asyncio.sleep(2**attempts)
                attempts += 1
            else:
                raise


def bad_request_matches(exc: Exception, *messages: str) -> bool:
    return isinstance(exc, TelegramBadRequest) and any(
        message in str(exc).lower() for message in messages
    )


def scan_gap(exc: Exception) -> bool:
    return bad_request_matches(
        exc,
        "message to forward not found",
        "message_id_invalid",
        "message can't be forwarded",
    )


def copy_source_unavailable(exc: Exception) -> bool:
    return bad_request_matches(
        exc,
        "message to copy not found",
        "message_id_invalid",
        "message can't be copied",
    )


def invalid_audio(exc: Exception) -> bool:
    return bad_request_matches(
        exc,
        "wrong file identifier",
        "wrong remote file identifier",
        "file_id_invalid",
        "file_reference_expired",
        "file reference expired",
    )


async def check_channel_rights(
    bot: Any, db: Database, chat_id: int, *, post: bool = True
) -> None:
    member = await retry_telegram(
        bot.get_chat_member, chat_id, bot.id, retry_transient=True
    )
    can_post = bool(getattr(member, "can_post_messages", False))
    can_delete = bool(getattr(member, "can_delete_messages", False))
    is_member = member.status not in {"left", "kicked"}
    db.execute(
        """UPDATE channels SET can_post=?,can_delete=?,is_member=?,updated_at=?
        WHERE chat_id=?""",
        (int(can_post), int(can_delete), int(is_member), now_iso(), chat_id),
    )
    if member.status != "administrator" or not can_delete or (post and not can_post):
        raise ValueError(
            f"Channel {chat_id}: give the bot administrator rights with Post Messages and Delete Messages, then retry."
        )
