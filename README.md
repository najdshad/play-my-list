# play-my-list

Turn audio from a Telegram channel into ordered, publishable playlists.

`play-my-list` is a Telegram bot plus a drag-and-drop Mini App. It indexes the audio already sitting in a **vault channel** you choose, lets you arrange tracks into named playlists, and publishes them as clean feeds in your **playlist channels** — deleting the bot's previous posts and copying the tracks over in order.

**The bot never stores audio.** It keeps message references, `file_id`s and metadata only. Your files stay in the vault channel.

## How it works

1. **Index the vault** — run `/setvault`, then forward any message from the vault channel. The bot probes the channel's message IDs, saves audio metadata, and deletes the forwarded copies. Scans resume after a restart, and `/resumescan` retries from the last saved cursor. New uploads are indexed as they arrive.
2. **Arrange playlists** — create named playlists, attach a channel, search the index, and drag tracks into order. Every change saves immediately.
3. **Publish** — the bot verifies its channel rights, removes the posts it published before, then copies each track from the vault (falling back to `sendAudio`). Progress is live, and message IDs are saved as it goes so an interrupted publish can clean up next time.

## Highlights

- Ordered playlists with instant saving in the Mini App.
- Publishing replaces the previous feed instead of appending to it.
- Per-track vault references survive playlist edits and channel moves.
- Runs entirely on Cloudflare, or self-hosted as a single Python process.
- One owner per bot; everyone else is ignored.

## Quick start

### Option A — Cloudflare (no server required)

The Worker serves the Mini App, REST API and Telegram webhook. A SQLite-backed Durable Object stores data and runs scans and publishes via durable alarms. Cloudflare supports `/syncvault` for incremental checks, `/rescan` for a full metadata refresh, and `/resumescan` for recovery. Publishing defaults to 1.1 seconds between posts, with persistent per-chat cooldowns; see [Cloudflare operations](cloudflare/README.md#operations-and-recovery).

Requires Node.js 22+ and a Cloudflare account with Workers and SQLite-backed Durable Objects.

```bash
npm ci
npx wrangler login
# set vars.OWNER_ID in wrangler.jsonc
cp .dev.vars.example .dev.vars
# set BOT_TOKEN and WEBHOOK_SECRET in .dev.vars
npm test
npm run deploy:check
npm run deploy
npx wrangler secret bulk .dev.vars
```

Cloudflare starts with a separate database — data is not migrated from an existing Python installation. See **[`cloudflare/README.md`](cloudflare/README.md)** for the full guide, including webhook registration and GitHub Actions deployment.

### Option B — Python runtime (local or VPS)

Requires Python 3.11+, SQLite, and a public HTTPS URL for the Mini App.

```bash
git clone <repo> && cd play-my-list
python -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env   # fill in BOT_TOKEN, OWNER_ID, WEB_APP_URL
python -m bot.main
```

Then in Telegram:

1. `/setvault` and forward a message from the vault channel. Wait for the scan to finish (`/scanstatus`).
2. Add the bot as an admin to each playlist channel. It discovers them automatically.
3. `/start`, open the Mini App, and build your first playlist.

### Telegram setup

- A **vault channel** where the bot is an admin with *Post Messages* and *Delete Messages*.
- One or more **playlist channels** where the bot is an admin with *Post Messages* and *Delete Messages*.
- Your numeric user ID as `OWNER_ID`. Only that account can use the bot.

Telegram normally allows bots to delete only messages posted within the last 48 hours. Administrator rights do not lift that limit.

## Commands

| Command | Action |
|---|---|
| `/start` | Welcome message and a button that opens the Mini App |
| `/help` | Getting started guide and available commands |
| `/setvault` | Choose the vault channel and start the first scan |
| `/scanstatus` | Scan progress and indexed track count |
| `/syncvault` | Check the vault for new tracks (Cloudflare only) |
| `/rescan` | Scan the whole vault again (updates in place, no duplicates) |
| `/resumescan` | Retry a failed scan without resetting its cursor |
| `/newplaylist <name>` | Create an empty playlist |
| `/list` | Playlists with track counts |
| `/publish <name>` | Publish a playlist |
| `/cancel` | Cancel running scans and publishing (Cloudflare only) |

## Configuration

Python runtime, via `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `BOT_TOKEN` | — | Bot token from @BotFather |
| `OWNER_ID` | — | Your Telegram user ID |
| `DATABASE_PATH` | `data/playlist_bot.db` | SQLite file |
| `WEB_APP_URL` | — | Public HTTPS URL of the Mini App |
| `WEB_APP_HOST` | `0.0.0.0` | Bind address |
| `WEB_APP_PORT` | `8080` | Bind port |
| `PUBLISH_DELAY_SECONDS` | `3.0` | Pause between published tracks (~20 messages/min) |
| `SCAN_DELAY_SECONDS` | `1.0` | Pause between scan batches (100 messages each) |
| `LOG_LEVEL` | `INFO` | Logging level |

Telegram 429 responses are always honored via `retry_after`, so these delays are floors, not guarantees. Cloudflare configuration lives in `wrangler.jsonc` and Worker secrets; see the [Cloudflare guide](cloudflare/README.md).

## Publishing, in practice

- Publishing refreshes the bot's permissions first, then deletes tracked posts from the channels where they were actually recorded — including after a playlist moves.
- If cleanup fails, publishing stops, keeps tracking the undeleted messages, and shows the error. Remove posts older than the deletion limit manually and retry; already-absent messages are skipped.
- Only confirmed-unavailable audio is marked missing. Permission failures and temporary outages fail the job without marking valid tracks unavailable. Copy/send timeouts are never retried blindly, because Telegram may already have accepted the post.
- Telegram delivery and SQLite commits cannot be atomic. After an ambiguous send failure, inspect the channel and remove any extra post manually before retrying. Publishing replaces posts in batches; it is not an atomic channel swap.
- Each track keeps its own vault channel. Changing the vault changes the search index shown in the app; existing playlists keep their source references. The vault cannot be a publish target.
- Edits are blocked during publishing, and simultaneous publishes sharing a channel are rejected to preserve ordering.
- Deleting a playlist first deletes its tracked posts from the channels where they were posted, then removes it. If cleanup fails, the playlist stays with tracking retained so you can retry. Publishing an empty playlist also clears its tracked posts. Failed or interrupted jobs stay visible when you reopen the editor, and a new publish clears partial output first.

### Upgrading from v1

Existing v1 databases migrate automatically to v2, preserving playlists, file IDs and tracked messages. **Back up the database before upgrading.** Because v1 cannot prove a track's original channel after vault changes, legacy tracks publish using their file IDs until `/rescan` refreshes their source references.

## Development

```bash
pip install -e '.[dev]'
python -m pytest -q
python -m build
node --check miniapp/app.js
```

Backend tests use temporary SQLite databases, signed test sessions and simulated Telegram calls. They cover API editing and publishing, authentication, schema migration, retries, permissions, channel moves, vault changes, and restart/shutdown recovery.

Browser smoke tests need Chrome and `agent-browser`:

```bash
python tests/browser_server.py
# in another terminal
python tests/browser_smoke.py
```

Set `AGENT_BROWSER_EXECUTABLE_PATH` if Chrome is in a custom location, or `AGENT_BROWSER_BIN` to point at a native `agent-browser` executable. The fixture binds only to `127.0.0.1:8765`, uses a temporary database and fake Telegram, and never reads `.env`. Close the browser afterward with `npx agent-browser --session playlist-review close`.

Cloudflare tests run with `npm test`.

## Project layout

```
bot/
  main.py            app entry point
  config.py          environment settings
  db/                schema, migrations, queries
  handlers/          commands, vault setup, channel membership
  api/               REST routes and initData auth
  services/          scanner, publisher, auth
cloudflare/          Worker, Durable Object, deployment guide
miniapp/             index.html, app.js, style.css (no build step)
tests/               backend and browser tests
```

## Documentation

- [`PRD.md`](PRD.md) — full specification: workflows, data model, API contract, error handling, out-of-scope items and open risks.
- [`cloudflare/README.md`](cloudflare/README.md) — Cloudflare setup, local testing, deployment and webhook registration.

## License

MIT — see [`LICENSE`](LICENSE).
