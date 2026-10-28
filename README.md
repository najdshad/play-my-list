# play-my-list

A Telegram bot and Mini App for building ordered music playlists and publishing them as clean audio feeds in Telegram channels.

The bot indexes audio from a **vault channel** you choose, you arrange playlists by drag-and-drop in the Mini App, and publishing clears the bot's tracked posts and copies the tracks over in order, provided Telegram allows deleting the earlier posts.

**The bot never stores audio.** It keeps message references, `file_id`s and metadata only. Files stay in the vault channel.

[`PRD.md`](PRD.md) describes the behaviour, data model and API implemented here.

## How it works

1. **Index the vault** — `/setvault`, then forward any message from the vault channel. The bot probes the channel's message IDs by forwarding each one to your DM, saving audio metadata and deleting the forwarded copy. Interrupted scans resume on startup; `/resumescan` retries a failed scan from its saved cursor. Live indexing picks up new uploads.
2. **Arrange playlists** — create named playlists, attach a channel, search the index, drag tracks into order. Every change saves immediately.
3. **Publish** — the bot checks its channel rights, deletes the messages it previously posted, then copies each track from the vault (falling back to `sendAudio`). Progress is shown live and message IDs are saved as it goes, so an interrupted publish cleans up correctly next time.

## Requirements

- One owner, set by `OWNER_ID`. Everyone else is ignored.
- A **vault channel** where the bot is admin with *Post Messages* and *Delete Messages*.
- One or more **playlist channels** where the bot is admin with *Post Messages* and *Delete Messages*. Telegram normally limits bot deletion to messages less than 48 hours old; administrator rights do not remove that documented limit.
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

## Publishing and recovery

Publishing refreshes the bot's permissions before deleting anything. Earlier posts are deleted from their recorded channels, including after a playlist moves. If cleanup fails, publishing stops, keeps tracking the undeleted messages, and shows the error. For posts older than Telegram permits deleting, remove them manually in Telegram and retry; already absent messages are skipped by Telegram.

Only confirmed unavailable audio files are marked missing. Permission failures and temporary outages fail the job without marking valid audio unavailable. A copy/send timeout is not retried or replaced with another send, because Telegram may already have accepted it.

Each track retains its own vault channel. Changing the vault changes the search index shown in the app; existing playlists keep their source references. The vault cannot be used as a publish target. Edits are blocked during publishing, and simultaneous publishes sharing a channel are rejected to preserve ordering.

Publishing an empty playlist clears its tracked posts. Do this before deleting a previously published playlist. Failed/interrupted jobs remain visible when reopening the editor. A new publish clears tracked partial output first.

Telegram delivery and SQLite commits cannot be atomic: a crash or lost response after Telegram accepts a post can leave an untracked message. Inspect the channel after an ambiguous send failure and remove any extra post manually before retrying. Publishing replaces posts in batches; it is not an atomic channel swap.

Existing v1 databases migrate automatically to v2, preserving playlists, file IDs, and tracked messages. Back up the database before upgrading. Since v1 cannot prove a track's original channel after vault changes, legacy tracks publish using their file IDs until `/rescan` verifies and refreshes their source references.

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
| `/resumescan` | Retry a failed scan without resetting its cursor |
| `/newplaylist <name>` | Create an empty playlist |
| `/list` | Playlists with track counts and channels |
| `/publish <name>` | Publish a playlist |

## Development and tests

```bash
pip install -e '.[dev]'
python -m pytest -q
python -m build
node --check miniapp/app.js
```

The backend tests use temporary SQLite databases, signed test sessions, and simulated Telegram calls. They cover API editing/publishing, authentication, schema migration, retries, permissions, channel moves, vault changes, and restart/shutdown recovery.

For browser smoke tests, install Chrome and `agent-browser` (or use `npx`). Start a fresh local fixture server in one terminal, then run the browser test in another:

```bash
python tests/browser_server.py
# In another terminal:
python tests/browser_smoke.py
```

Set `AGENT_BROWSER_EXECUTABLE_PATH` if Chrome is in a custom location. Install `agent-browser` globally or set `AGENT_BROWSER_BIN` to its native executable to avoid repeated `npx` startup overhead. The fixture binds only to `127.0.0.1:8765`, uses a temporary database and fake Telegram, and never reads `.env`. It tests the real Mini App and REST API together. Close the browser with `npx agent-browser --session playlist-review close` afterward.

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
