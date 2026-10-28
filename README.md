# play-my-list

A Telegram bot and Mini App for building ordered music playlists and publishing them as clean audio feeds in Telegram channels.

The bot indexes audio from a **vault channel** you choose, you arrange playlists by drag-and-drop in the Mini App, and publishing clears the playlist channel's earlier posts and copies the tracks over in order.

**The bot never stores audio.** It keeps message references, `file_id`s and metadata only. Files stay in the vault channel.

[`PRD.md`](PRD.md) describes the behaviour, data model and API implemented here.

## How it works

1. **Index the vault** — `/setvault`, then forward any message from the vault channel. The bot probes the channel's message IDs by forwarding each one to your DM, keeping the audio and deleting the copy. Scans are resumable and live indexing picks up new uploads.
2. **Arrange playlists** — create named playlists, attach a channel, search the index, drag tracks into order. Every change saves immediately.
3. **Publish** — the bot checks its channel rights, deletes the messages it previously posted, then copies each track from the vault (falling back to `sendAudio`). Progress is shown live and message IDs are saved as it goes, so an interrupted publish cleans up correctly next time.

## Requirements

- One owner, set by `OWNER_ID`. Everyone else is ignored.
- A **vault channel** where the bot is admin with *Post Messages* and *Delete Messages*.
- One or more **playlist channels** where the bot is admin with *Post Messages* and *Delete Messages*. Deleting channel messages needs `can_delete_messages`; that is what lifts the 48-hour deletion limit.
- Python 3.11+, SQLite, and a public HTTPS URL for the Mini App.

## Setup

```bash
git clone <repo> && cd play-my-list
python -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env   # fill in BOT_TOKEN, OWNER_ID, WEB_APP_URL
python -m bot.main
```

Then in Telegram:

1. `/setvault` and forward a message from the vault channel. Wait for the scan to finish (`/scanstatus`).
2. Add the bot as admin to each playlist channel. It discovers them automatically.
3. `/start` and open the Mini App to build playlists.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BOT_TOKEN` | — | Bot token from @BotFather |
| `OWNER_ID` | — | Your Telegram user ID |
| `DATABASE_PATH` | `data/playlist_bot.db` | SQLite file |
| `WEB_APP_URL` | — | Public HTTPS URL of the Mini App |
| `WEB_APP_HOST` | `0.0.0.0` | Bind address |
| `WEB_APP_PORT` | `8080` | Bind port |
| `PUBLISH_DELAY_SECONDS` | `3.0` | Pause between published tracks (~20 messages/min) |
| `SCAN_DELAY_SECONDS` | `1.0` | Pause between scan forwards (~1 message/s) |
| `LOG_LEVEL` | `INFO` | Logging level |

429 responses are always honored via `retry_after`, so the delays above are floors, not guarantees.

## Commands

| Command | Action |
|---|---|
| `/start` | Welcome message and a button that opens the Mini App |
| `/setvault` | Choose the vault channel and start the first scan |
| `/scanstatus` | Scan progress and indexed track count |
| `/rescan` | Scan the whole vault again (updates in place, no duplicates) |
| `/newplaylist <name>` | Create an empty playlist |
| `/list` | Playlists with track counts and channels |
| `/publish <name>` | Publish a playlist |

## Deployment

One asyncio process: aiogram polling for the bot, aiohttp for the Mini App and REST API, SQLite in WAL mode. No external services besides Telegram.

Run it with Docker or systemd behind Caddy for automatic HTTPS, and back up the database daily:

```bash
sqlite3 data/playlist_bot.db ".backup 'backup/playlist_bot-$(date +%F).db'"
```

## Project layout

```
bot/
  main.py            app entry point
  config.py          environment settings
  db/                schema, migrations, queries
  handlers/          commands, vault setup, channel membership
  api/               REST routes and initData auth
  services/          scanner, publisher, auth
miniapp/             index.html, app.js, style.css (no build step)
tests/
data/
```

The `playlist-bot/` prefix in the PRD is the project root; paths here are relative to it.

## Docs

- [`PRD.md`](PRD.md) — full spec: workflows, data model, API contract, error handling, out-of-scope items, open risks.

## License

MIT — see [`LICENSE`](LICENSE).
