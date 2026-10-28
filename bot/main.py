from __future__ import annotations

import asyncio
import logging
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover

    def load_dotenv() -> None:
        return None


from bot.api.server import API
from bot.config import Config
from bot.db.database import Database
from bot.handlers.owner import build_router
from bot.services.publisher import Publisher
from bot.services.scanner import Scanner


async def run() -> None:
    load_dotenv()
    config = Config.from_env()
    logging.basicConfig(
        level=getattr(logging, config.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        from aiogram import Bot, Dispatcher
        from aiohttp import web
    except ImportError as exc:
        raise RuntimeError("Install requirements.txt before running the bot") from exc
    db = Database(config.database_path).open()
    bot = Bot(config.bot_token)
    scanner = Scanner(bot, db, config.owner_id, config.scan_delay_seconds)
    publisher = Publisher(
        bot, db, config.publish_delay_seconds, owner_id=config.owner_id
    )
    dp = Dispatcher()
    dp.include_router(build_router(db, config, scanner, publisher))
    api = API(
        db,
        config.bot_token,
        config.owner_id,
        Path(__file__).resolve().parents[1] / "miniapp",
        publisher,
    )
    runner = web.AppRunner(api.app())
    try:
        publisher.recover()
        await runner.setup()
        site = web.TCPSite(runner, config.web_app_host, config.web_app_port)
        await site.start()
        scanner.resume()
        await dp.start_polling(bot, close_bot_session=False)
    finally:
        await runner.cleanup()
        await scanner.close()
        await publisher.close()
        await bot.session.close()
        db.close()


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
