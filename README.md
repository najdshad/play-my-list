# play-my-list

Turn audio from a Telegram channel into ordered, publishable playlists.

`play-my-list` is a Telegram bot plus a drag-and-drop Mini App. It indexes the audio already sitting in a **vault channel** you choose, lets you arrange tracks into named playlists, and publishes them as clean feeds in your **playlist channels** — deleting the bot's previous posts and copying the tracks over in order.

**The bot never stores audio.** It keeps message references, `file_id`s and metadata only. Your files stay in the vault channel.

## How it works

1. **Index the vault** — run `/setvault`, then forward any message from the vault channel. The Worker probes the channel's message IDs, saves audio metadata, and deletes the forwarded copies. Scans resume after a restart, and `/resumescan` retries from the last saved cursor. New uploads are indexed as they arrive.
2. **Arrange playlists** — create named playlists, attach a channel, search the index, and drag tracks into order. Every change saves immediately.
3. **Publish** — the bot verifies its channel rights, removes the posts it published before, then copies each track from the vault (falling back to `sendAudio`). Progress is live, and message IDs are saved as it goes so an interrupted publish can clean up next time.

## Highlights

- Ordered playlists with instant saving in the Mini App.
- Publishing replaces the previous feed instead of appending to it.
- Per-track vault references survive playlist edits and channel moves.
- Runs entirely on Cloudflare Workers with no server to manage.
- One owner per bot; everyone else is ignored.

## Quick start

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

See **[`cloudflare/README.md`](cloudflare/README.md)** for the full guide, including webhook registration and GitHub Actions deployment.

### Telegram setup

- A **vault channel** where the bot is an admin with *Post Messages* and *Delete Messages*.
- One or more **playlist channels** where the bot is an admin with *Post Messages* and *Delete Messages*.
- Your numeric user ID as `OWNER_ID`. Only that account can use the bot.

Telegram normally allows bots to delete only messages posted within the last 48 hours. Administrator rights do not lift that limit for a bot. The Worker can optionally use a Telegram account session (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`) to delete posts of any age; see the [Cloudflare guide](cloudflare/README.md#deleting-old-channel-posts).

## Commands

| Command | Action |
|---|---|
| `/start` | Welcome message and a button that opens the Mini App |
| `/help` | Getting started guide and available commands |
| `/setvault` | Choose the vault channel and start the first scan |
| `/scanstatus` | Scan progress and indexed track count |
| `/syncvault` | Check the vault for new tracks |
| `/rescan` | Scan the whole vault again (updates in place, no duplicates) |
| `/resumescan` | Retry a failed scan without resetting its cursor |
| `/newplaylist <name>` | Create an empty playlist |
| `/list` | Playlists with track counts |
| `/publish <name>` | Publish a playlist |
| `/cancel` | Cancel running scans and publishing |

## Configuration

Worker variables live in `wrangler.jsonc`; secrets live in `.dev.vars` and are uploaded with `npx wrangler secret bulk .dev.vars`.

| Name | Kind | Default | Purpose |
|---|---|---|---|
| `BOT_TOKEN` | Secret | — | Bot token from @BotFather |
| `WEBHOOK_SECRET` | Secret | — | Shared secret Telegram sends with webhook updates |
| `OWNER_ID` | Variable | — | Your Telegram user ID |
| `PUBLISH_DELAY_SECONDS` | Variable | `1.1` | Pause between published tracks |
| `SCAN_DELAY_SECONDS` | Variable | `1` | Pause between scan steps |
| `TELEGRAM_API_ID` | Secret, optional | — | Account API ID for deleting old posts |
| `TELEGRAM_API_HASH` | Secret, optional | — | Account API hash for deleting old posts |
| `TELEGRAM_SESSION` | Secret, optional | — | Account session string for deleting old posts |

Telegram 429 responses are always honored via `retry_after`, so these delays are floors, not guarantees. See the [Cloudflare guide](cloudflare/README.md) for setup and deployment details.

## Publishing, in practice

- Publishing refreshes the bot's permissions first, then deletes tracked posts from the channels where they were actually recorded — including after a playlist moves.
- If cleanup fails, publishing stops, keeps tracking the undeleted messages, and shows the error. Configure the account session to delete old posts; otherwise remove posts older than the bot deletion limit manually and retry. Already-absent messages are skipped.
- Only confirmed-unavailable audio is marked missing. Permission failures and temporary outages fail the job without marking valid tracks unavailable. Copy/send timeouts are never retried blindly, because Telegram may already have accepted the post.
- Telegram delivery and database commits cannot be atomic. After an ambiguous send failure, inspect the channel and remove any extra post manually before retrying. Publishing replaces posts in batches; it is not an atomic channel swap.
- Each track keeps its own vault channel. Changing the vault changes the search index shown in the app; existing playlists keep their source references. The vault cannot be a publish target.
- Edits are blocked during publishing, and simultaneous publishes sharing a channel are rejected to preserve ordering.
- Deleting a playlist first deletes its tracked posts from the channels where they were posted, then removes it. If cleanup fails, the playlist stays with tracking retained so you can retry. Publishing an empty playlist also clears its tracked posts. Failed or interrupted jobs stay visible when you reopen the editor, and a new publish clears partial output first.
- Database cleanup keeps the latest finished publish result per playlist and all running jobs. Unused tracks from previous vaults and confirmed-unavailable audio are removed; the current vault library, playlist tracks, and published-message references are retained. A scan removes unused metadata for source messages it confirms are gone. Cleanup runs after relevant changes and daily.

## Development

```bash
npm ci
npm test
node --check miniapp/app.js
npm run deploy:check
```

Tests run in Cloudflare's `workerd` runtime with local Durable Object SQLite and mocked Telegram responses. They cover API editing and publishing, authentication, retries, permissions, channel moves, vault changes, and recovery. They do not register a webhook or send real Telegram messages.

## Project layout

```
cloudflare/
  src/               Worker, Durable Object, Telegram API, MTProto cleanup
  scripts/           webhook setup and MTProto session helpers
  test/              Worker tests
miniapp/             index.html, app.js, style.css (no build step)
wrangler.jsonc       Worker and Durable Object configuration
```

## Documentation

- [`cloudflare/README.md`](cloudflare/README.md) — Cloudflare setup, local testing, deployment and webhook registration.

## License

MIT — see [`LICENSE`](LICENSE).
