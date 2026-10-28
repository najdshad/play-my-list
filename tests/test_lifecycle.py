from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from bot.db.database import Database
from bot.services.publisher import Publisher
from bot.services.scanner import Scanner


async def test_startup_resumes_and_shutdown_closes_services_before_database(
    tmp_path, monkeypatch, bot
):
    import aiogram
    import bot.main as entry

    database = Database(tmp_path / "lifecycle.db").open()
    database.set_setting("vault_chat_id", -9001)
    database.set_setting("scan_cursor", 2)
    database.set_setting("scan_state", "running")
    scanner = Scanner(bot, database, 7, 0)
    publisher = Publisher(bot, database, 0)
    bot.session = SimpleNamespace(close=AsyncMock())
    called = []
    real_scan_close = scanner.close
    real_publish_close = publisher.close

    async def close_scan():
        assert database.conn is not None
        called.append("scanner")
        await real_scan_close()

    async def close_publish():
        assert database.conn is not None
        called.append("publisher")
        await real_publish_close()

    scanner.close = close_scan
    publisher.close = close_publish

    async def polling(*args, **kwargs):
        assert kwargs["close_bot_session"] is False
        assert scanner.task is not None
        await scanner.task
        raise RuntimeError("stop test polling")

    dispatcher = SimpleNamespace(
        include_router=lambda router: None, start_polling=polling
    )
    config = SimpleNamespace(
        log_level="INFO",
        database_path=database.path,
        bot_token="123:fake",
        owner_id=7,
        publish_delay_seconds=0,
        scan_delay_seconds=0,
        web_app_host="127.0.0.1",
        web_app_port=0,
    )
    monkeypatch.setattr(entry, "load_dotenv", lambda: None)
    monkeypatch.setattr(entry.Config, "from_env", lambda: config)
    monkeypatch.setattr(
        entry, "Database", lambda path: SimpleNamespace(open=lambda: database)
    )
    monkeypatch.setattr(aiogram, "Bot", lambda token: bot)
    monkeypatch.setattr(aiogram, "Dispatcher", lambda: dispatcher)
    monkeypatch.setattr(entry, "Scanner", lambda *args: scanner)
    monkeypatch.setattr(entry, "Publisher", lambda *args, **kwargs: publisher)
    monkeypatch.setattr(entry, "build_router", lambda *args: None)
    with pytest.raises(RuntimeError, match="stop test polling"):
        await entry.run()
    bot.forward_message.assert_awaited_once_with(7, -9001, 3)
    assert called == ["scanner", "publisher"]
    bot.session.close.assert_awaited_once()
    assert database.conn is None
