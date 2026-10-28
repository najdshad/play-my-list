## 1. Overview

This bot lets a single owner build ordered music playlists and publish them as clean audio feeds in Telegram channels.

- It indexes audio from a vault channel that the owner chooses.
- The owner arranges playlists in a Telegram Mini App with drag-and-drop.
- To publish, the bot clears its earlier posts from the playlist channel and copies the tracks over from the vault in order.

**Core rule:** the bot never stores audio files. It stores message references, `file_id`s and metadata only. The vault channel is where the actual files live.

## 2. Goals & Non-Goals

**Goals**
- One owner only
- Index the whole vault automatically, then keep picking up new uploads
- Multiple named playlists, each tied to one channel
- Drag-and-drop ordering in a Mini App
- Publishing that is safe to repeat, recovers from crashes and respects rate limits
- One process and no outside services besides Telegram

**Non-Goals**
- Multiple users
- Changing audio files or their tags
- Playing audio inside the app
- Using the Mini App outside Telegram
- Shared or collaborative editing

## 3. User Roles

| Role | Description |
|---|---|
| Owner | The single user set by `OWNER_ID`. Bot commands check this ID. Mini App requests are verified through `initData`. Everyone else is ignored silently. |

## 4. Required Bot Permissions

| Channel | Bot role | Required rights | Why |
|---|---|---|---|
| Vault | Admin | Post Messages, Delete Messages | Receive `channel_post` updates and run the max-ID probe (post a temporary message, then delete it) |
| Playlist | Admin | Post Messages, Delete Messages | Publish tracks. With `can_delete_messages`, the bot can delete any channel message, so the 48-hour deletion limit doesn't apply. |
| Owner DM | — | — | Forward-probe target: forwarded copies are read, then deleted |

## 5. Core Workflows

### 5.1 Vault Setup & Initial Scan
1. The owner sends `/setvault`, then forwards any message from the vault channel.
2. The bot reads the channel ID from `forward_origin` and uses `getChatMember` to check its admin rights. It saves `vault_chat_id` in `settings`.
3. **Finding the newest message ID:** the bot posts a temporary message in the vault, records its `message_id` as `scan_max_id`, and deletes it right away.
4. **Forward-probe loop**, for each ID from `scan_cursor + 1` to `scan_max_id`:
   - The bot calls `forwardMessage(vault → owner DM, id)`.
   - If the forward contains `audio`, the bot saves or updates the track by `file_unique_id`.
   - The forwarded copy is deleted from the DM straight away.
   - If the message is missing or can't be forwarded (deleted, or a service message), the bot treats it as a gap and moves on.
   - `scan_cursor` is saved after every ID, so the scan can resume after a restart.
   - The loop waits `SCAN_DELAY_SECONDS` between calls and honors `RetryAfter`.
5. The scan runs in the background. `/scanstatus` shows `cursor / max` and how many tracks are indexed.
6. **Live indexing:** a `channel_post` handler indexes new audio as soon as it's posted to the vault.
7. `/rescan` resets `scan_cursor` to 0 and scans everything again. Existing tracks are updated in place, never duplicated.

> **Why forwarding:** the Bot API has no method for reading channel history. `forwardMessages` (plural) only returns message IDs, not the content, so each message has to be forwarded on its own.

### 5.2 Channel Discovery
1. When the owner adds the bot to a channel, Telegram sends a `my_chat_member` update.
2. The bot saves or updates the channel in `channels`, with its title, `can_post` and `can_delete`.
3. If the bot is removed or demoted, the row is updated to match. Playlists tied to that channel are flagged "unavailable" in the UI.
4. The Mini App's channel picker lists the rows where `can_post AND can_delete` are both true.

### 5.3 Playlist Management
1. The owner creates a playlist with `/newplaylist <name>` or in the Mini App.
2. The owner picks a channel for it in the Mini App (from `channels`).
3. The owner searches the vault index, adds or removes tracks, and drags them into order.
4. Every change is saved immediately. Reorders are saved in one transaction: the playlist's positions are deleted and rewritten, which avoids clashes under `UNIQUE(playlist_id, position)`.

### 5.4 Publish
1. The owner taps **Publish** in the Mini App or sends `/publish <name>`.
2. **Pre-flight checks:**
   - The playlist has a channel.
   - `getChatMember` confirms the bot still has post and delete rights there.
   - No other publish is running for this playlist (per-playlist lock).
3. **Clear:** the bot deletes the tracked `published_messages` with `deleteMessages`, in batches of up to 100. Any IDs that fail are logged and dropped from tracking.
4. **Post:** for each track, in order:
   - First it tries `copyMessage(vault → playlist, vault_message_id)`. Copying leaves no "forwarded from" header.
   - If that fails, it tries `sendAudio(playlist, file_id)`.
   - If both fail, the track is skipped and marked `missing = 1`.
   - Each new `message_id` is saved to `published_messages` immediately.
   - The bot waits `PUBLISH_DELAY_SECONDS` between tracks and honors `RetryAfter`.
5. **Progress:** a job record (`status, progress, total, skipped`) is updated as tracks are posted. The Mini App polls `/api/jobs/:id`, and a status message in the owner's DM is edited every N tracks.
6. **Finish:** the bot sends a summary with how many tracks were posted and skipped, plus a list of skipped titles.

**Crash recovery:** because message IDs are saved as soon as each one is posted, the next publish cleans up partial output correctly.

## 6. Data Model

### `settings` (key–value)
| Key | Value |
|---|---|
| `vault_chat_id` | Vault channel ID |
| `scan_cursor` | Last vault message ID processed |
| `scan_max_id` | Highest message ID found by the probe |
| `scan_state` | `idle` / `running` / `done` / `error` |

### `channels`
| Column | Type | Notes |
|---|---|---|
| chat_id | INTEGER PK | Telegram channel ID |
| title | TEXT | |
| can_post | INTEGER | 0/1 |
| can_delete | INTEGER | 0/1 |
| is_member | INTEGER | 0 if the bot was removed |
| updated_at | TEXT | ISO timestamp |

### `tracks`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| file_unique_id | TEXT UNIQUE | Key used to avoid duplicates |
| file_id | TEXT | Used by the `sendAudio` fallback |
| vault_message_id | INTEGER | Source for `copyMessage` |
| title | TEXT NULL | From audio metadata |
| performer | TEXT NULL | From audio metadata |
| file_name | TEXT NULL | Searched when tags are empty |
| duration | INTEGER | Seconds |
| file_size | INTEGER | Bytes |
| missing | INTEGER | 1 if the vault source is gone |
| indexed_at | TEXT | ISO timestamp |

Indexes cover `title`, `performer` and `file_name`. FTS5 is an option if the vault grows large.

### `playlists`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT UNIQUE | |
| channel_id | INTEGER NULL FK | → `channels.chat_id` |
| last_published_at | TEXT NULL | |
| created_at | TEXT | |

### `playlist_tracks`
| Column | Type | Notes |
|---|---|---|
| playlist_id | INTEGER FK | ON DELETE CASCADE |
| track_id | INTEGER FK | ON DELETE CASCADE |
| position | INTEGER | Counts from 0 |
| | | `PRIMARY KEY(playlist_id, track_id)`, `UNIQUE(playlist_id, position)` |

### `published_messages`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| playlist_id | INTEGER FK | ON DELETE CASCADE |
| chat_id | INTEGER | Channel the message was posted to (handles a playlist being moved to another channel) |
| message_id | INTEGER | |
| track_id | INTEGER NULL | |
| published_at | TEXT | |

The schema version is tracked with `PRAGMA user_version`. The database runs in WAL mode with foreign keys enabled.

## 7. Bot Commands

| Command | Action |
|---|---|
| `/start` | Welcome message and a button that opens the Mini App |
| `/setvault` | Choose the vault channel and start the first scan |
| `/scanstatus` | Show scan progress and track count |
| `/rescan` | Scan the whole vault again |
| `/newplaylist <name>` | Create an empty playlist |
| `/list` | List playlists with track counts and channels |
| `/publish <name>` | Publish a playlist |

## 8. Mini App

**Stack:** plain HTML, CSS and JS, with Sortable.js loaded from a CDN. There is no build step.

**Auth:** every request sends `X-Telegram-Init-Data`. The server:
- builds the secret key as `HMAC_SHA256("WebAppData", BOT_TOKEN)`,
- checks `hash` against it,
- rejects data whose `auth_date` is more than 24 hours old,
- requires `user.id == OWNER_ID`.

**Views (single column, mobile first):**
1. **Playlists:** cards showing name, track count, channel, last published date and a warning badge if the channel is unavailable
2. **Editor:** search bar with results at the top and the ordered list with drag handles below. Missing tracks are greyed out and flagged.
3. **Publish progress:** progress bar, current track, number skipped

**UX:**
- Colors follow Telegram's `themeParams`, so light and dark mode work automatically.
- Uses Telegram's native `BackButton` and `MainButton` (as "Publish").
- Haptic feedback when tracks are dragged and dropped.
- Changes show up immediately (optimistic updates). Reorder saves are debounced by about 400ms and rolled back if the save fails.
- Empty, loading and error states are designed explicitly.

## 9. API

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/channels` | — | `[{chat_id, title, can_post, can_delete}]` |
| GET | `/api/playlists` | — | `[{id, name, channel_id, track_count, last_published_at}]` |
| POST | `/api/playlists` | `{name}` | `{id, name}` |
| PATCH | `/api/playlists/:id` | `{name?, channel_id?}` | `{ok}` |
| DELETE | `/api/playlists/:id` | — | `{ok}` |
| GET | `/api/playlists/:id` | — | `{id, name, channel_id, tracks:[...]}` |
| POST | `/api/playlists/:id/tracks` | `{track_id}` | `{ok}` |
| DELETE | `/api/playlists/:id/tracks/:track_id` | — | `{ok}` |
| PUT | `/api/playlists/:id/order` | `{track_ids:[...]}` | `{ok}` |
| GET | `/api/tracks?q=&limit=&offset=` | — | `[{id, title, performer, file_name, duration, missing}]` |
| POST | `/api/playlists/:id/publish` | — | `{job_id}` |
| GET | `/api/jobs/:job_id` | — | `{status, progress, total, skipped}` |

Errors use the shape `{error, code}`, with status 400 (invalid input), 401 (failed auth), 404 (not found), 409 (publish already running) or 422 (channel not ready).

## 10. Architecture

┌──────────────── Single asyncio process ────────────────┐
│ aiogram (polling)                                      │
│   ├─ owner filter                                      │
│   ├─ commands                                          │
│   ├─ channel_post   → live vault indexing              │
│   └─ my_chat_member → channels table                   │
│ Background tasks                                       │
│   ├─ Scanner   (forward-probe, resumable)              │
│   └─ Publisher (job registry, per-playlist locks)      │
│ aiohttp                                                │
│   ├─ /       → Mini App static files                   │
│   └─ /api/*  → REST (initData middleware)              │
│ SQLite (aiosqlite, WAL)                                │
└────────────────────────────────────────────────────────┘


## 11. Rate Limits & Constraints

| Item | Limit / Behavior |
|---|---|
| Posting to a channel | About 20 messages/min. The default `PUBLISH_DELAY_SECONDS` is 3.0. |
| Forwarding to the owner's DM (scan) | About 1 message/s. The default `SCAN_DELAY_SECONDS` is 1.0. |
| 429 errors | The bot always waits for the `retry_after` period, then retries |
| `deleteMessages` | Up to 100 IDs per call |
| Rough timings | A 1,000-message vault takes about 17 minutes to scan. A 50-track playlist takes about 2.5 minutes to publish. |

## 12. Error Handling

| Situation | What the bot does |
|---|---|
| Bot lacks rights in the playlist channel | Pre-flight fails with a 422 response and setup instructions |
| Bot removed from the vault | Scanning stops, `scan_state = error`, the owner is notified, and the existing index is kept |
| `copyMessage` fails | Falls back to `sendAudio(file_id)` |
| Both fail | Skips the track, sets `missing = 1` and reports it in the summary |
| Delete fails during publish | Logs it, stops tracking that message and carries on |
| Publish already running | 409 response, "already publishing" |
| Bad or expired `initData` | 401 response, the Mini App shows a "reopen from bot" screen |
| Crash during a scan or publish | Picks up from `scan_cursor`. Messages already published are cleaned up by the next publish. |

## 13. Configuration

```env
BOT_TOKEN=
OWNER_ID=
DATABASE_PATH=data/playlist_bot.db
WEB_APP_URL=https://your-domain.tld
WEB_APP_HOST=0.0.0.0
WEB_APP_PORT=8080
PUBLISH_DELAY_SECONDS=3.0
SCAN_DELAY_SECONDS=1.0
LOG_LEVEL=INFO
```

## 14. Dependencies

aiogram>=3.7
aiosqlite>=0.20
aiohttp>=3.9


**Deployment:** Docker or systemd, with Caddy in front for automatic HTTPS and a daily `sqlite3 .backup`.

## 15. Project Structure

playlist-bot/
├── bot/
│   ├── main.py
│   ├── config.py
│   ├── db/
│   │   ├── schema.sql
│   │   ├── migrate.py
│   │   └── queries.py
│   ├── handlers/
│   │   ├── commands.py
│   │   ├── vault.py
│   │   └── membership.py
│   ├── api/
│   │   ├── routes.py
│   │   └── middleware.py
│   └── services/
│       ├── scanner.py
│       ├── publisher.py
│       └── auth.py
├── miniapp/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── tests/
├── data/
├── .env.example
├── Dockerfile
├── requirements.txt
└── README.md


## 16. Out of Scope (v1)

- Scheduled or automatic republishing
- More than one vault channel
- Duplicating playlists or using templates
- Importing or exporting playlists
- Custom captions or cover art
- Publishing only what changed (v1 always clears and reposts everything)

## 17. Open Risks (checked in Phase 0)

1. **Scan speed on large vaults.** If forward-probing is too slow, the fallback is Pyrogram with the bot token, whose `get_messages` reads messages by ID without forwarding.
2. **Deleting old messages.** We need to confirm that `can_delete_messages` really removes the 48-hour limit on channel posts.
3. **Real channel posting limits.** We need to test the actual 429 threshold so we can tune `PUBLISH_DELAY_SECONDS`.
