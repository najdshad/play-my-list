# Deploy the whole project on Cloudflare

The Mini App, REST API, Telegram webhook, database, and background jobs run on Cloudflare. No Python process, VPS, tunnel, D1 database, or audio storage is needed for this deployment.

The Worker serves the existing `miniapp/` assets and authenticates API requests using Telegram's signed `initData`. One SQLite-backed Durable Object holds the owner's playlists, tracks, channel permissions, message tracking, webhook deduplication records, and pending work. Durable Object alarms advance scans and publishes with at most one Telegram request per step. Each confirmed scan forward saves its metadata and cursor immediately; cleanup uses one `deleteMessages` call after ten forwards or at completion. Delays and flood waits are persisted instead of sleeping in a request handler.

## Current deployment

```text
https://play-my-list.alirezanajdshad28.workers.dev
```

This repository's Worker and Telegram webhook are deployed at that address. Open the app through **Open playlists** after sending `/start` to the bot. Updates can be deployed automatically through GitHub Actions or manually with `npm run deploy`; existing Worker secrets and Durable Object data are retained.

## Automatic deployment from GitHub

The GitHub Actions workflow tests and deploys the Worker on pushes to `main`. It can also be started manually from the Actions tab. To enable it, add these repository secrets under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with permission to edit Workers in the account containing this Worker (the **Edit Cloudflare Workers** token template can be used).
- `CLOUDFLARE_ACCOUNT_ID`: the ID of that Cloudflare account, available in the Cloudflare dashboard.

These credentials are for deployment only. `BOT_TOKEN` and `WEBHOOK_SECRET` remain Worker secrets and do not need to be added to GitHub Actions. A failed test prevents deployment.

## Requirements

- Node.js 22+ and npm.
- A Cloudflare account with Workers and SQLite-backed Durable Objects enabled. Check your account's current limits and billing before deploying.
- A Telegram bot token and your numeric Telegram user ID.
- A vault channel and at least one separate publish channel. Make the bot an administrator of the vault (read and forward only; no Post or Delete permissions are needed) and give it Post Messages and Delete Messages in publish channels. Disable Restrict Saving Content in the vault.

## First deployment

From the repository root:

```bash
npm ci
npx wrangler login
```

Edit `wrangler.jsonc`: set `vars.OWNER_ID` to your numeric Telegram user ID. You may also change the Worker `name`. Keep the Durable Object binding, class name, migration, and owner ID stable after you begin storing data.

Create local credentials:

```bash
cp .dev.vars.example .dev.vars
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Edit `.dev.vars`, setting `BOT_TOKEN` and using the generated value as `WEBHOOK_SECRET`. This file is ignored by Git. Do not put either secret in `wrangler.jsonc` or the Mini App files.

Validate and deploy:

```bash
npm test
npm run deploy:check
npm run deploy
npx wrangler secret bulk .dev.vars
```

The initial deployment creates the Worker and Durable Object migration. Uploading the secrets then configures the Worker. Wrangler prints your HTTPS Worker address, such as `https://play-my-list.YOUR-SUBDOMAIN.workers.dev`.

**Stop any Python polling process using this bot token before registering the webhook.** A bot uses webhook delivery instead of long polling in this deployment.

```bash
npm run telegram:setup -- https://play-my-list.YOUR-SUBDOMAIN.workers.dev
npm run telegram:status
```

The setup script checks `/health`, registers `/telegram/webhook` with Telegram using the webhook secret, preserves pending updates, enables the update types the app needs, and updates the bot's command menu. It reads the same `.dev.vars` credentials you uploaded. It does not print your bot token or webhook secret.

If your network requires an HTTP proxy, use a current Node.js 22 release and enable proxy support when running the helper, for example `NODE_OPTIONS=--use-env-proxy npm run telegram:status`. Node reads `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` with that flag. Wrangler already detects proxy environment variables.

Open your bot in Telegram, send `/start`, and tap **Open playlists**. The button uses the deployed webhook's origin automatically. For a custom Mini App domain, route that domain to this Worker and register its HTTPS address using the setup command. Optionally configure `WEB_APP_URL` as a Worker variable to override the button address.

## Functional test

1. Send `/setvault` and forward the newest message from the vault to the bot. The forward sets the scan's upper bound, so it must be the latest upload.
2. Check `/scanstatus` until the scan is done. Temporary forwards appear in your DM and are deleted as scanning advances.
3. Add the bot to the destination channel, or toggle its administrator permissions so Telegram sends a membership update if it was already an administrator before deployment.
4. Send `/start`, open the Mini App, create a playlist, select the destination, search, and add two or three tracks.
5. Reorder and publish. Check that the destination contains the tracks in the selected order.
6. Reopen the editor while publishing to check progress recovery.
7. Reorder and publish again to check cleanup and replacement.
8. Delete the playlist; its tracked posts are removed from the channel first.

Publishing preflight failures now appear in the job progress, because channel permissions are checked by the durable job before any deletion. No request needs to stay open while tracks are published.

## Local development

```bash
npm ci
cp .dev.vars.example .dev.vars
# Fill in .dev.vars and set OWNER_ID in wrangler.jsonc.
npm run dev
```

Wrangler uses local SQLite-backed Durable Objects. Local data persists under `.wrangler/` and is separate from your deployed database. Opening the local page in a regular browser shows the Telegram sign-in instructions; the real app requires a signed Telegram session.

```bash
npm test
npm run deploy:check
```

Tests run in Cloudflare's `workerd` runtime with local Durable Object SQLite and mocked Telegram responses. They do not register a webhook or send real Telegram messages. The Python test/demo commands in the root README continue to exercise the original Python implementation.

## Operations and recovery

```bash
npx wrangler tail
npm run telegram:status
```

Send `/cancel` to stop any running scan or publish. Cancelling a publish keeps its already-posted messages tracked, so publishing again cleans them up; cancelling a scan retains temporary forwarded-copy IDs for cleanup when scanning resumes.

The database and pending tasks survive Worker requests, eviction, and deployments. Do not delete the Durable Object namespace or change the owner ID/name mapping to reset the app: that selects a different database. The deployment migration creates storage; future schema changes require a migration rather than dropping tables.

Use `/syncvault` to check for new tracks: forward the newest message from the configured vault when prompted. Forwards from other channels are rejected. Synchronization starts after that vault's persistent coverage checkpoint, including previously checked gaps and non-audio messages. Matching tracks already indexed from live channel updates are reused within the new range. A high live message ID alone never advances coverage. The forwarded upper bound stays fixed for that run.

Use `/rescan` for a full metadata refresh, including cached tracks, or `/resumescan` for recovery. Each confirmed forward atomically saves metadata, cleanup IDs, cursor progress, and the cleared in-flight marker. Scan failures retain this progress; confirmed forwarded-message IDs stay in `scan_pending` until deletion succeeds. Permission failures never become skipped message IDs. After an ambiguous forward, inspect the DM and remove any untracked extra copy before explicitly resuming.

Checkpoints and destination pacing live in the existing settings storage. On upgrade, coverage for the current vault starts at its saved scan cursor; existing pending jobs remain intact. Each vault retains its own checkpoint when switching vaults.

`PUBLISH_DELAY_SECONDS` defaults to `1.1` seconds and honors explicit overrides. `SCAN_DELAY_SECONDS` sets the owner-chat interval, with a minimum of `1.1` seconds between owner messages, including scan forwards and notifications. Normal cooldowns are persisted per destination: a waiting owner chat or channel does not block eligible work elsewhere. Alarms wake for the earliest eligible task. A Telegram `429` still pauses the whole bot for `retry_after`; the affected chat's interval doubles up to the greater of five seconds or its configured floor. Twenty successful sends restore that floor. Channel locks and sequential playlist jobs preserve individual posts in playlist order.

For 100 tracks, the default configured publishing pauses are about 109 seconds, down from about 297 seconds, before request time and flood waits. Initial metadata scans still need individual forwards because bulk forwarding returns message IDs without full audio metadata. A 1,000-ID initial scan needs 1,000 metadata requests; synchronization over the next 20 IDs inspects only those 20 and makes no metadata request for live-indexed tracks. Tests benchmark this case with ten live-indexed tracks: ten forwards and one cleanup request.

Structured logs record Telegram request methods, counts, durations, flood waits, and scan cache reuse. They omit tokens, request URLs, and message contents.

Publish failures preserve tracked output. Retry publishing to clean up partial posts first. If old posts cannot be deleted, remove them manually in Telegram and retry. The bot cannot bypass Telegram's deletion limits.

Telegram sends cannot be atomic with database writes. Before each send/copy/forward the app durably records an in-flight operation. If the runtime stops with an uncertain result, it stops that job and asks you to inspect Telegram rather than replaying a potentially accepted message. Read-only requests and confirmed deletions can retry; flood waits are persisted. Failed owner notifications are not retried after uncertain delivery.

Back up important playlists and maintain the vault channel. This deployment uses its own new Cloudflare database: **an existing Python SQLite database is not automatically imported.** Keep the Python database as a backup; select and rescan the vault and recreate playlists in Cloudflare before retiring the old deployment. Channel posts tracked only by the old deployment are not automatically adopted or deleted by this one.

The static UI is public; all `/api/*` data and mutations require the configured owner's valid Telegram session. Webhook requests require the secret token sent by Telegram. The test bridge in `tests/browser_server.py` is never deployed.

## Cloudflare documentation

- [Static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Workers testing](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Telegram webhooks](https://core.telegram.org/bots/api#setwebhook)
