import time
from unittest.mock import AsyncMock

import pytest
from aiogram.exceptions import TelegramRetryAfter
from aiogram.methods import GetChatMember

from bot.config import Config
from bot.services.auth import AuthError, verify_init_data
from bot.services.telegram import retry_telegram
from conftest import signed_init_data


@pytest.mark.parametrize("age", [90000, -120])
def test_expired_and_future_auth_rejected(age):
    with pytest.raises(AuthError, match="expired"):
        verify_init_data(
            signed_init_data(auth_date=int(time.time()) - age), "test-token", 7
        )


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("OWNER_ID", "-1"),
        ("WEB_APP_URL", "http://example.test"),
        ("PUBLISH_DELAY_SECONDS", "nan"),
        ("SCAN_DELAY_SECONDS", "-1"),
        ("WEB_APP_PORT", "65536"),
    ],
)
def test_invalid_configuration_fails_early(monkeypatch, key, value):
    monkeypatch.setenv("BOT_TOKEN", "123:test-token")
    monkeypatch.setenv("OWNER_ID", "7")
    monkeypatch.setenv("WEB_APP_URL", "https://example.test")
    monkeypatch.setenv(key, value)
    with pytest.raises(ValueError):
        Config.from_env()


async def test_retry_after_is_honored(no_retry_wait):
    call = AsyncMock(
        side_effect=[
            TelegramRetryAfter(
                method=GetChatMember(chat_id=-1001, user_id=123),
                message="flood",
                retry_after=6,
            ),
            "ok",
        ]
    )
    assert await retry_telegram(call) == "ok"
    no_retry_wait.assert_awaited_once_with(6.0)


async def test_transient_retry_is_bounded_and_sends_opt_out(no_retry_wait):
    call = AsyncMock(side_effect=ConnectionError("offline"))
    with pytest.raises(ConnectionError):
        await retry_telegram(call, retry_transient=True)
    assert call.await_count == 4
    assert [c.args[0] for c in no_retry_wait.await_args_list] == [1, 2, 4]
    call.reset_mock()
    with pytest.raises(ConnectionError):
        await retry_telegram(call)
    assert call.await_count == 1
