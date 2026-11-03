import { DurableObject } from "cloudflare:workers";
import {
  AppError,
  body,
  errorResponse,
  integer,
  json,
  playlistName,
} from "./auth.js";
import { Store, now } from "./store.js";
import {
  telegram,
  TelegramError,
  transient,
  scanGap,
  sourceUnavailable,
  invalidAudio,
  matches,
} from "./telegram.js";

export class PlaylistApp extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = new Store(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      if (
        this.db.one("SELECT 1 FROM tasks") &&
        (await ctx.storage.getAlarm()) === null
      )
        await this.schedule();
    });
  }

  async fetch(request) {
    // Serialize API mutations and each alarm step, including the Telegram await.
    // There is at most one bounded Telegram request per alarm (12s timeout).
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const url = new URL(request.url);
        let response;
        if (url.pathname === "/telegram/webhook" && request.method === "POST") {
          const update = await body(request);
          integer(update.update_id, "update_id", 0);
          this.db.atomic(() => {
            if (
              this.db.one("SELECT 1 FROM updates WHERE id=?", update.update_id)
            )
              return;
            this.db.exec(
              "INSERT INTO updates VALUES(?,?)",
              update.update_id,
              Date.now(),
            );
            this.db.exec(
              "DELETE FROM updates WHERE received_at<?",
              Date.now() - 7 * 86400000,
            );
            this.db.set("web_app_url", url.origin);
            this.update(update);
          });
          response = json({ ok: true });
        } else response = await this.api(request, url);
        await this.schedule();
        return response;
      } catch (error) {
        return errorResponse(error);
      }
    });
  }

  async schedule() {
    const next = this.db.one("SELECT MIN(due_at) due FROM tasks");
    if (next?.due === null || next?.due === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const due = Math.max(
      next.due,
      Number(this.db.setting("bot_not_before", "0")),
      Date.now() + 1,
    );
    await this.ctx.storage.setAlarm(due);
  }

  playlist(id, editable = false) {
    const row = this.db.one(
      "SELECT * FROM playlists WHERE id=?",
      integer(id, "playlist id", 1),
    );
    if (!row) throw new AppError("Playlist not found.", 404, "not_found");
    if (
      editable &&
      this.db.one(
        "SELECT 1 FROM jobs WHERE playlist_id=? AND status='running'",
        row.id,
      )
    ) {
      throw new AppError(
        "Wait for publishing to finish before editing this playlist.",
        409,
        "already_running",
      );
    }
    return row;
  }

  async api(request, url) {
    const path = url.pathname,
      method = request.method;
    if (path === "/api/channels" && method === "GET")
      return json(
        this.db.all(
          `SELECT chat_id,title,can_post,can_delete,is_member FROM channels WHERE is_member=1 AND can_post=1 AND can_delete=1 AND chat_id!=COALESCE(CAST(? AS INTEGER),0) ORDER BY title`,
          this.db.setting("vault_chat_id"),
        ),
      );
    if (path === "/api/tracks" && method === "GET") {
      const limit = Math.min(
        100,
        integer(url.searchParams.get("limit") ?? 50, "limit", 1),
      );
      const offset = integer(url.searchParams.get("offset") ?? 0, "offset", 0);
      const q = (url.searchParams.get("q") || "").trim(),
        vault = this.db.setting("vault_chat_id");
      return json(
        this.db.all(
          `SELECT id,title,performer,file_name,duration,missing FROM tracks WHERE (?='' OR title LIKE ? OR performer LIKE ? OR file_name LIKE ?) AND (? IS NULL OR vault_chat_id=CAST(? AS INTEGER)) ORDER BY indexed_at DESC,id DESC LIMIT ? OFFSET ?`,
          q,
          `%${q}%`,
          `%${q}%`,
          `%${q}%`,
          vault,
          vault,
          limit,
          offset,
        ),
      );
    }
    if (path === "/api/playlists") {
      if (method === "GET") return json(this.db.playlists());
      if (method === "POST") {
        const input = await body(request),
          name = playlistName(input.name);
        return json(
          this.db.one(
            "INSERT INTO playlists(name,created_at) VALUES(?,?) RETURNING id,name",
            name,
            now(),
          ),
          201,
        );
      }
    }
    const job = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (job && method === "GET") {
      const result = this.db.job(integer(job[1], "job id", 1));
      if (!result) throw new AppError("Job not found.", 404, "not_found");
      return json(result);
    }
    const match = path.match(
      /^\/api\/playlists\/([^/]+)(?:\/(tracks|order|publish)(?:\/([^/]+))?)?$/,
    );
    if (!match) throw new AppError("Not found.", 404, "not_found");
    const [, id, action, trackId] = match;
    const row = this.playlist(id, method !== "GET" && action !== "publish");
    if (!action) {
      if (method === "GET") {
        const latest = this.db.one(
          "SELECT id FROM jobs WHERE playlist_id=? ORDER BY id DESC LIMIT 1",
          row.id,
        );
        return json({
          ...row,
          tracks: this.db.tracks(row.id),
          latest_job: latest ? this.db.job(latest.id) : null,
          published_count: this.db.one(
            "SELECT COUNT(*) n FROM published_messages WHERE playlist_id=?",
            row.id,
          ).n,
        });
      }
      if (method === "PATCH") {
        const input = await body(request),
          values = [],
          fields = [];
        if ("name" in input) {
          fields.push("name=?");
          values.push(playlistName(input.name));
        }
        if ("channel_id" in input) {
          const channel = input.channel_id;
          if (channel !== null) {
            if (!Number.isSafeInteger(channel))
              throw new AppError("channel_id must be an integer or null.");
            if (String(channel) === this.db.setting("vault_chat_id"))
              throw new AppError(
                "The vault cannot be a publish channel.",
                422,
                "not_ready",
              );
            const rights = this.db.one(
              "SELECT * FROM channels WHERE chat_id=?",
              channel,
            );
            if (!rights)
              throw new AppError("Channel not found.", 404, "not_found");
            if (!rights.is_member || !rights.can_post || !rights.can_delete)
              throw new AppError(
                "Give the bot Post Messages and Delete Messages permissions.",
                422,
                "not_ready",
              );
          }
          fields.push("channel_id=?");
          values.push(channel);
        }
        if (fields.length)
          this.db.exec(
            `UPDATE playlists SET ${fields.join(",")} WHERE id=?`,
            ...values,
            row.id,
          );
        return json({ ok: true });
      }
      if (method === "DELETE") {
        if (
          this.db.one(
            "SELECT 1 FROM published_messages WHERE playlist_id=?",
            row.id,
          )
        )
          throw new AppError(
            "Remove all tracks and publish the empty playlist to clear its previous posts before deleting it.",
            409,
            "published_messages_remain",
          );
        this.db.exec("DELETE FROM playlists WHERE id=?", row.id);
        return json({ ok: true });
      }
    }
    if (action === "tracks") {
      if (method === "POST" && !trackId) {
        const input = await body(request),
          tid = input.track_id;
        if (!Number.isSafeInteger(tid) || tid < 1)
          throw new AppError("track_id must be a positive integer.");
        if (!this.db.one("SELECT 1 FROM tracks WHERE id=?", tid))
          throw new AppError("Track not found.", 404, "not_found");
        this.db.exec(
          "INSERT OR IGNORE INTO playlist_tracks SELECT ?,?,COALESCE(MAX(position),-1)+1 FROM playlist_tracks WHERE playlist_id=?",
          row.id,
          tid,
          row.id,
        );
        return json({ ok: true });
      }
      if (method === "DELETE" && trackId) {
        this.db.exec(
          "DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?",
          row.id,
          integer(trackId, "track id", 1),
        );
        return json({ ok: true });
      }
    }
    if (action === "order" && method === "PUT" && !trackId) {
      const { track_ids: ids } = await body(request),
        current = this.db.tracks(row.id).map((t) => t.id);
      if (
        !Array.isArray(ids) ||
        ids.some((i) => !Number.isSafeInteger(i)) ||
        new Set(ids).size !== ids.length ||
        ids.length !== current.length ||
        ids.some((i) => !current.includes(i))
      )
        throw new AppError(
          "Order must contain the playlist tracks exactly once.",
        );
      this.db.order(row.id, ids);
      return json({ ok: true });
    }
    if (action === "publish" && method === "POST" && !trackId)
      return json({ job_id: this.startPublish(row.id) }, 202);
    throw new AppError("Method not allowed.", 405, "http_error");
  }

  notify(text, extra = {}) {
    this.db.enqueue("notification", {
      chat_id: Number(this.env.OWNER_ID),
      text: String(text).slice(0, 4000),
      ...extra,
    });
  }

  scanBusy() {
    return !!this.db.one(
      "SELECT 1 FROM tasks WHERE kind IN ('scan','select_vault')",
    );
  }

  startScan(vault, reset = false) {
    if (this.scanBusy())
      throw new AppError("A scan is already running.", 409, "already_running");
    const changed = this.db.setting("vault_chat_id") !== String(vault);
    if (reset || changed) {
      this.db.set("scan_cursor", 0);
      this.db.set("scan_max_id", 0);
    }
    let resume = null;
    if (!reset && !changed)
      resume = JSON.parse(this.db.setting("scan_resume", "null"));
    this.db.set("vault_chat_id", vault);
    this.db.set("scan_state", "running");
    this.db.set("scan_error", "");
    this.db.set("scan_resume", "null");
    this.db.enqueue("scan", resume || { vault, phase: "probe" });
  }

  assertVault(vault) {
    if (
      this.db.one("SELECT 1 FROM playlists WHERE channel_id=?", vault) ||
      this.db.one("SELECT 1 FROM published_messages WHERE chat_id=?", vault)
    )
      throw new AppError(
        "Choose a channel that is not used for playlist publishing.",
      );
  }

  update(update) {
    const membership = update.my_chat_member;
    if (membership?.chat?.type === "channel")
      this.db.channel(membership.chat, membership.new_chat_member);
    const post = update.channel_post || update.edited_channel_post;
    if (post && String(post.chat.id) === this.db.setting("vault_chat_id"))
      this.db.index(post);
    const message = update.message;
    if (
      message?.chat?.type !== "private" ||
      message.from?.id !== Number(this.env.OWNER_ID)
    )
      return;
    try {
      const [command = "", ...parts] = (message.text || "").trim().split(/\s+/);
      const name = parts.join(" ");
      switch (command.split("@")[0]) {
        case "/start": {
          const url = this.env.WEB_APP_URL || this.db.setting("web_app_url");
          this.notify("Build and publish your playlists.", {
            reply_markup: {
              inline_keyboard: [[{ text: "Open playlists", web_app: { url } }]],
            },
          });
          return;
        }
        case "/setvault":
          this.db.set("pending_vault", "1");
          this.notify("Forward any message from the vault channel to me.");
          return;
        case "/scanstatus":
          this.notify(
            `Scan: ${this.db.setting("scan_state", "idle")} (${this.db.setting("scan_cursor", "0")}/${this.db.setting("scan_max_id", "0")}); indexed tracks: ${this.db.one("SELECT COUNT(*) n FROM tracks WHERE vault_chat_id=CAST(? AS INTEGER)", this.db.setting("vault_chat_id")).n}${this.db.setting("scan_error") ? `\n${this.db.setting("scan_error")}\nUse /resumescan to retry.` : ""}`,
          );
          return;
        case "/rescan":
        case "/resumescan": {
          const vault = this.db.setting("vault_chat_id");
          if (!vault) throw new AppError("Set a vault first with /setvault.");
          this.startScan(Number(vault), command.split("@")[0] === "/rescan");
          this.notify("Scan started. Use /scanstatus for progress.");
          return;
        }
        case "/newplaylist":
          this.db.exec(
            "INSERT INTO playlists(name,created_at) VALUES(?,?)",
            playlistName(name),
            now(),
          );
          this.notify(`Created playlist: ${name}`);
          return;
        case "/list":
          this.notify(
            this.db
              .playlists()
              .map((p) => `${p.name} — ${p.track_count} tracks`)
              .join("\n") || "No playlists yet.",
          );
          return;
        case "/publish": {
          const row = this.db.one(
            "SELECT id FROM playlists WHERE name=?",
            name,
          );
          if (!row) throw new AppError("Playlist not found.");
          this.startPublish(row.id);
          return;
        }
      }
      if (message.forward_origin && this.db.setting("pending_vault") === "1") {
        const chat = message.forward_origin.chat;
        if (!chat || chat.type !== "channel")
          throw new AppError("That message does not identify a channel.");
        if (this.scanBusy())
          throw new AppError(
            "A scan is already running. Wait for it to finish.",
          );
        this.assertVault(chat.id);
        this.db.enqueue("select_vault", { vault: chat.id, phase: "chat" });
      }
    } catch (error) {
      this.notify(
        error instanceof AppError
          ? error.message
          : "That playlist name is unavailable.",
      );
    }
  }

  startPublish(pid) {
    const playlist = this.playlist(pid, true),
      tracks = this.db.tracks(pid),
      chat = playlist.channel_id;
    if (chat === null)
      throw new AppError("Choose a playlist channel first.", 422, "not_ready");
    if (
      String(chat) === this.db.setting("vault_chat_id") ||
      tracks.some((t) => t.vault_chat_id === chat)
    )
      throw new AppError(
        "A vault channel cannot be used as the publish channel.",
        422,
        "not_ready",
      );
    const old = this.db.all(
      "SELECT DISTINCT chat_id FROM published_messages WHERE playlist_id=?",
      pid,
    );
    if (!tracks.length && !old.length)
      throw new AppError(
        "Add at least one track before publishing.",
        422,
        "not_ready",
      );
    const channels = [...new Set([chat, ...old.map((r) => r.chat_id)])];
    if (
      channels.some((c) =>
        this.db.one("SELECT 1 FROM channel_locks WHERE chat_id=?", c),
      )
    )
      throw new AppError(
        "Another playlist is publishing to one of these channels. Wait for it to finish.",
        409,
        "already_running",
      );
    return this.db.atomic(() => {
      const state = {
        name: playlist.name,
        chat,
        channels,
        check: 0,
        phase: "permissions",
        tracks: tracks.map((t) => t.id),
      };
      const job = this.db.one(
        "INSERT INTO jobs(playlist_id,status,total,created_at,updated_at,state) VALUES(?,'running',?,?,?,?) RETURNING id",
        pid,
        tracks.length,
        now(),
        now(),
        JSON.stringify(state),
      );
      channels.forEach((c) =>
        this.db.exec("INSERT INTO channel_locks VALUES(?,?)", c, job.id),
      );
      this.db.enqueue("publish", { job: job.id });
      this.notify(`Publishing ${playlist.name}: 0/${tracks.length}`);
      return job.id;
    });
  }

  async call(task, method, parameters, unsafe = false) {
    if (unsafe) {
      this.db.exec("UPDATE tasks SET inflight=? WHERE id=?", method, task.id);
      // Make the intent durable before making a non-idempotent external request.
      await this.ctx.storage.sync();
    }
    try {
      return await telegram(this.env.BOT_TOKEN, method, parameters);
    } catch (error) {
      if (
        error instanceof TelegramError &&
        error.code >= 400 &&
        error.code < 500
      )
        this.db.exec("UPDATE tasks SET inflight=NULL WHERE id=?", task.id);
      throw error;
    }
  }

  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const task = this.db.one(
        "SELECT * FROM tasks ORDER BY due_at,id LIMIT 1",
      );
      if (!task) return;
      if (
        task.due_at > Date.now() ||
        Number(this.db.setting("bot_not_before", "0")) > Date.now()
      ) {
        await this.schedule();
        return;
      }
      const payload = JSON.parse(task.payload);
      try {
        if (task.inflight)
          throw new AppError(
            `An interrupted ${task.inflight} request may have been accepted by Telegram. Inspect the channel or DM for an extra message before retrying.`,
            409,
            "interrupted",
          );
        if (task.kind === "publish") await this.publishStep(task, payload);
        else if (task.kind === "scan") await this.scanStep(task, payload);
        else if (task.kind === "select_vault")
          await this.selectVaultStep(task, payload);
        else if (task.kind === "notification") {
          await this.call(task, "sendMessage", payload, true);
          this.db.exec("DELETE FROM tasks WHERE id=?", task.id);
          this.db.set("bot_not_before", Date.now() + 1000);
        }
      } catch (error) {
        if (error instanceof TelegramError && error.retryAfter !== null) {
          const due =
            Date.now() +
            Math.max(1, Number(error.retryAfter) || 1) * 1000 +
            100;
          this.db.exec(
            "UPDATE tasks SET due_at=?,inflight=NULL WHERE id=?",
            due,
            task.id,
          );
          this.db.set("bot_not_before", due);
        } else {
          const unsafe = this.db.one(
            "SELECT inflight FROM tasks WHERE id=?",
            task.id,
          )?.inflight;
          if (transient(error) && !unsafe && task.attempts < 3) {
            this.db.exec(
              "UPDATE tasks SET attempts=attempts+1,due_at=? WHERE id=?",
              Date.now() + 1000 * 2 ** task.attempts,
              task.id,
            );
          } else this.failTask(task, payload, error, !!unsafe);
        }
      }
      await this.schedule();
    });
  }

  failTask(task, payload, error, ambiguous = false) {
    let message = error.message || "The operation failed.";
    if (ambiguous && !(error instanceof AppError))
      message +=
        " Telegram may have accepted the current message. Inspect the channel or DM for an extra message before retrying.";
    this.db.atomic(() => {
      if (task.kind === "publish") {
        const job = this.db.one("SELECT * FROM jobs WHERE id=?", payload.job);
        const state = JSON.parse(job.state);
        if (state.phase === "clear")
          message +=
            " Previous-post tracking has been retained. Check Delete Messages permission; Telegram normally limits deletion to 48 hours. If necessary, delete the old posts manually, then publish again.";
        this.finishPublish(
          task,
          job,
          error.code === "interrupted" ? "interrupted" : "error",
          message,
        );
      } else {
        this.db.exec("DELETE FROM tasks WHERE id=?", task.id);
        if (task.kind === "scan") {
          this.db.set("scan_state", "error");
          this.db.set("scan_error", message);
          this.db.set("scan_resume", JSON.stringify(payload));
          this.notify(
            `Vault scan stopped: ${message} Progress was saved. Use /resumescan to retry.`,
          );
        } else if (task.kind === "select_vault")
          this.notify(`Could not set the vault: ${message}`);
        // Do not retry a notification with an ambiguous result or create a loop.
      }
    });
  }

  finishPublish(task, job, status = "done", error = null) {
    const state = JSON.parse(job.state);
    this.db.exec(
      "UPDATE jobs SET status=?,error=?,current_track=NULL,updated_at=? WHERE id=?",
      status,
      error,
      now(),
      job.id,
    );
    if (status === "done" && job.progress > job.skipped)
      this.db.exec(
        "UPDATE playlists SET last_published_at=? WHERE id=?",
        now(),
        job.playlist_id,
      );
    this.db.exec("DELETE FROM channel_locks WHERE job_id=?", job.id);
    this.db.exec("DELETE FROM tasks WHERE id=?", task.id);
    const titles = JSON.parse(job.skipped_titles);
    this.notify(
      status === "done"
        ? `Published ${state.name}: ${job.progress - job.skipped} posted, ${job.skipped} skipped.${titles.length ? `\nSkipped: ${titles.join(", ")}` : ""}`
        : `Publishing ${state.name} failed: ${error}`,
    );
  }

  async publishStep(task, payload) {
    const job = this.db.one("SELECT * FROM jobs WHERE id=?", payload.job);
    if (!job || job.status !== "running") {
      this.db.exec("DELETE FROM tasks WHERE id=?", task.id);
      return;
    }
    const state = JSON.parse(job.state);
    const save = (delay = 0) => {
      this.db.exec(
        "UPDATE jobs SET state=?,updated_at=? WHERE id=?",
        JSON.stringify(state),
        now(),
        job.id,
      );
      this.db.updateTask(task, payload, delay);
    };
    if (state.phase === "permissions") {
      const channel = state.channels[state.check];
      if (channel === undefined) {
        state.phase = "clear";
        save();
        return;
      }
      const rights = await this.call(task, "getChatMember", {
        chat_id: channel,
        user_id: Number(this.env.BOT_TOKEN.split(":")[0]),
      });
      this.db.channel({ id: channel }, rights);
      if (
        rights.status !== "administrator" ||
        !rights.can_delete_messages ||
        (channel === state.chat && !rights.can_post_messages)
      )
        throw new AppError(
          `Channel ${channel}: give the bot administrator rights with Post Messages and Delete Messages, then retry.`,
        );
      state.check++;
      save();
      return;
    }
    if (state.phase === "clear") {
      const first = this.db.one(
        "SELECT chat_id FROM published_messages WHERE playlist_id=? ORDER BY id LIMIT 1",
        job.playlist_id,
      );
      if (!first) {
        state.phase = "send";
        save();
        return;
      }
      const batch = this.db.all(
        "SELECT id,message_id FROM published_messages WHERE playlist_id=? AND chat_id=? ORDER BY id LIMIT 100",
        job.playlist_id,
        first.chat_id,
      );
      await this.call(task, "deleteMessages", {
        chat_id: first.chat_id,
        message_ids: batch.map((r) => r.message_id),
      });
      this.db.atomic(() => {
        this.db.exec(
          `DELETE FROM published_messages WHERE id IN (${batch.map(() => "?").join(",")})`,
          ...batch.map((r) => r.id),
        );
        save();
      });
      return;
    }
    if (job.progress >= job.total) {
      this.db.atomic(() => this.finishPublish(task, job));
      return;
    }
    const track = this.db.one(
      "SELECT * FROM tracks WHERE id=?",
      state.tracks[job.progress],
    );
    if (!track) throw new AppError("A playlist track is no longer available.");
    const title = track.title || track.file_name || "Untitled";
    this.db.exec("UPDATE jobs SET current_track=? WHERE id=?", title, job.id);
    const copy = track.vault_chat_id !== null && !state.fallback;
    let result,
      skipped = false;
    try {
      result = await this.call(
        task,
        copy ? "copyMessage" : "sendAudio",
        copy
          ? {
              chat_id: state.chat,
              from_chat_id: track.vault_chat_id,
              message_id: track.vault_message_id,
            }
          : { chat_id: state.chat, audio: track.file_id },
        true,
      );
    } catch (error) {
      if (copy && sourceUnavailable(error)) {
        state.fallback = true;
        save();
        return;
      }
      if (!copy && invalidAudio(error)) skipped = true;
      else throw error;
    }
    this.db.atomic(() => {
      const titles = JSON.parse(job.skipped_titles);
      if (skipped) titles.push(title);
      else
        this.db.exec(
          "INSERT INTO published_messages(playlist_id,chat_id,message_id,track_id,published_at) VALUES(?,?,?,?,?)",
          job.playlist_id,
          state.chat,
          result.message_id,
          track.id,
          now(),
        );
      this.db.exec(
        "UPDATE tracks SET missing=? WHERE id=?",
        Number(skipped),
        track.id,
      );
      this.db.exec(
        "UPDATE jobs SET progress=progress+1,skipped=?,skipped_titles=? WHERE id=?",
        titles.length,
        JSON.stringify(titles),
        job.id,
      );
      state.fallback = false;
      save(Number(this.env.PUBLISH_DELAY_SECONDS ?? 3) * 1000);
      this.db.set(
        "bot_not_before",
        Date.now() + Number(this.env.PUBLISH_DELAY_SECONDS ?? 3) * 1000,
      );
      if ((job.progress + 1) % 10 === 0 && job.progress + 1 < job.total)
        this.notify(
          `Publishing ${state.name}: ${job.progress + 1}/${job.total}, skipped ${titles.length}`,
        );
    });
  }

  async selectVaultStep(task, payload) {
    this.assertVault(payload.vault);
    if (payload.phase === "chat") {
      const chat = await this.call(task, "getChat", { chat_id: payload.vault });
      if (chat.type !== "channel")
        throw new AppError("The vault must be a channel.");
      if (chat.has_protected_content)
        throw new AppError(
          "Turn off Restrict Saving Content in the vault before scanning.",
        );
      this.db.updateTask(task, {
        ...payload,
        phase: "rights",
        title: chat.title || "",
      });
      return;
    }
    const rights = await this.call(task, "getChatMember", {
      chat_id: payload.vault,
      user_id: Number(this.env.BOT_TOKEN.split(":")[0]),
    });
    if (
      rights.status !== "administrator" ||
      !rights.can_post_messages ||
      !rights.can_delete_messages
    )
      throw new AppError(
        "Give the bot Post Messages and Delete Messages permissions in the vault.",
      );
    this.db.atomic(() => {
      this.db.channel({ id: payload.vault, title: payload.title }, rights);
      this.db.exec("DELETE FROM tasks WHERE id=?", task.id);
      this.startScan(payload.vault, true);
      this.db.set("pending_vault", "0");
      this.notify("Vault saved; scan started. Use /scanstatus for progress.");
    });
  }

  async scanStep(task, payload) {
    const owner = Number(this.env.OWNER_ID);
    const delay = Number(this.env.SCAN_DELAY_SECONDS ?? 1) * 1000;
    const next = (changes, wait = 0) =>
      this.db.updateTask(task, { ...payload, ...changes }, wait);
    if (payload.phase === "probe") {
      const probe = await this.call(
        task,
        "sendMessage",
        { chat_id: payload.vault, text: "Scanning…" },
        true,
      );
      this.db.atomic(() => {
        this.db.set("scan_max_id", probe.message_id - 1);
        next({
          phase: "delete_probe",
          max: probe.message_id - 1,
          probe: probe.message_id,
        });
      });
      return;
    }
    if (payload.phase === "delete_probe") {
      try {
        await this.call(task, "deleteMessage", {
          chat_id: payload.vault,
          message_id: payload.probe,
        });
      } catch (error) {
        if (!matches(error, "message to delete not found")) throw error;
      }
      next({ phase: "forward" });
      return;
    }
    if (payload.phase === "delete_forward") {
      try {
        await this.call(task, "deleteMessage", {
          chat_id: owner,
          message_id: payload.forwarded,
        });
      } catch (error) {
        if (!matches(error, "message to delete not found")) throw error;
      }
      this.db.atomic(() => {
        this.db.set("scan_cursor", payload.message);
        next({ phase: "forward", forwarded: null }, delay);
        this.db.set("bot_not_before", Date.now() + delay);
      });
      return;
    }
    const message = Number(this.db.setting("scan_cursor", "0")) + 1;
    if (message > payload.max) {
      this.db.atomic(() => {
        this.db.exec("DELETE FROM tasks WHERE id=?", task.id);
        this.db.set("scan_state", "done");
        this.db.set("scan_error", "");
        this.notify(
          `Vault scan finished. Indexed ${this.db.one("SELECT COUNT(*) n FROM tracks WHERE vault_chat_id=?", payload.vault).n} tracks.`,
        );
      });
      return;
    }
    let forwarded;
    try {
      forwarded = await this.call(
        task,
        "forwardMessage",
        { chat_id: owner, from_chat_id: payload.vault, message_id: message },
        true,
      );
    } catch (error) {
      if (!scanGap(error)) throw error;
      this.db.atomic(() => {
        this.db.set("scan_cursor", message);
        next({}, delay);
      });
      return;
    }
    this.db.atomic(() => {
      this.db.index(forwarded, payload.vault, message);
      next({
        phase: "delete_forward",
        forwarded: forwarded.message_id,
        message,
      });
    });
  }
}
