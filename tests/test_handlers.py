from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiogram import Bot, Dispatcher
from aiogram.types import Chat, Message, Update, User

from bot.handlers.owner import build_router


async def dispatch(db, text, user_id=7, chat_type="private", scanner=None):
    session = AsyncMock()
    bot = Bot("123:test-token", session=session)
    dp = Dispatcher()
    config = SimpleNamespace(owner_id=7, web_app_url="https://example.test")
    scanner = scanner or SimpleNamespace(start=lambda *a, **kw: None)
    dp.include_router(build_router(db, config, scanner, SimpleNamespace()))
    await dp.feed_update(
        bot,
        Update(
            update_id=1,
            message=Message(
                message_id=1,
                date=datetime.now(timezone.utc),
                chat=Chat(id=7, type=chat_type),
                from_user=User(id=user_id, first_name="Owner", is_bot=False),
                text=text,
            ),
        ),
    )
    return session


async def test_start_uses_authenticated_inline_webapp_launch(db):
    session = await dispatch(db, "/start")
    method = session.await_args.args[1]
    assert (
        method.reply_markup.inline_keyboard[0][0].web_app.url == "https://example.test"
    )


@pytest.mark.parametrize(("user_id", "chat_type"), [(8, "private"), (7, "group")])
async def test_other_users_and_group_commands_are_ignored(db, user_id, chat_type):
    session = await dispatch(db, "/start", user_id, chat_type)
    session.assert_not_awaited()


async def test_resume_command_keeps_cursor_and_rescan_resets(db):
    from unittest.mock import Mock

    scanner = SimpleNamespace(start=Mock())
    await dispatch(db, "/resumescan", scanner=scanner)
    scanner.start.assert_called_once_with(-9001, rescan=False)
    scanner.start.reset_mock()
    await dispatch(db, "/rescan", scanner=scanner)
    scanner.start.assert_called_once_with(-9001, rescan=True)
