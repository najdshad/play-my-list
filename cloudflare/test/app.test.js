import { env } from "cloudflare:workers";
import {
  runInDurableObject,
  runDurableObjectAlarm,
  reset,
  evictDurableObject,
} from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { hmac } from "../src/auth.js";
import { TelegramError } from "../src/telegram.js";

let calls, fail, nextMessage, vaultMarker, authorization, stub;

async function signed({
  owner = 7,
  token = "123:test-token",
  authDate = Math.floor(Date.now() / 1000),
} = {}) {
  const fields = new URLSearchParams({
    auth_date: String(authDate),
    user: JSON.stringify({ id: owner }),
  });
  const check = [...fields]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const hash = new Uint8Array(
    await hmac(await hmac("WebAppData", token), check),
  );
  fields.set(
    "hash",
    [...hash].map((n) => n.toString(16).padStart(2, "0")).join(""),
  );
  return fields.toString();
}

async function inside(callback) {
  return runInDurableObject(stub, callback);
}

async function api(method, path, data, status = 200, auth = authorization) {
  const response = await worker.fetch(
    new Request(`https://app.example/api${path}`, {
      method,
      headers: {
        "X-Telegram-Init-Data": auth,
        "Content-Type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
    env,
  );
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(status);
  return result;
}

async function webhook(update, status = 200, secret = env.WEBHOOK_SECRET) {
  const response = await worker.fetch(
    new Request("https://app.example/telegram/webhook", {
      method: "POST",
      headers: {
        "X-Telegram-Bot-Api-Secret-Token": secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(update),
    }),
    env,
  );
  expect(response.status).toBe(status);
  return response.json();
}

async function command(text, update_id = 1, extra = {}) {
  return webhook({
    update_id,
    message: {
      chat: { id: 7, type: "private" },
      from: { id: 7 },
      text,
      ...extra,
    },
  });
}

async function step() {
  return inside(async (app) => {
    if (!app.db.one("SELECT 1 FROM tasks")) return false;
    app.db.exec("UPDATE tasks SET due_at=0");
    app.db.set("bot_not_before", "0");
    for (const row of app.db.all("SELECT key,value FROM settings WHERE key LIKE 'chat_pacing:%'")) {
      app.db.set(row.key, JSON.stringify({ ...JSON.parse(row.value), until: 0 }));
    }
    await app.alarm();
    return true;
  });
}

async function drain() {
  for (let i = 0; i < 3000; i++) if (!(await step())) return;
  throw new Error("Jobs did not finish after 3000 alarm steps");
}

async function seed() {
  await inside((app) => {
    app.db.set("vault_chat_id", -9001);
    for (const id of [-9001, -1001, -1002])
      app.db.channel(
        { id, title: `Channel ${id}` },
        {
          status: "administrator",
          can_post_messages: true,
          can_delete_messages: true,
        },
      );
    for (let i = 1; i <= 3; i++)
      app.db.index({
        message_id: i,
        chat: { id: -9001 },
        audio: {
          file_unique_id: `unique-${i}`,
          file_id: `file-${i}`,
          title: ["Blue", "Red", "Green"][i - 1],
          performer: "Band",
          duration: 10,
        },
      });
  });
  const p = await api("POST", "/playlists", { name: "Road trip" }, 201);
  await api("PATCH", `/playlists/${p.id}`, { channel_id: -1001 });
  for (let i = 1; i <= 3; i++)
    await api("POST", `/playlists/${p.id}/tracks`, { track_id: i });
  return p.id;
}

beforeEach(async () => {
  calls = [];
  fail = null;
  nextMessage = 100;
  vaultMarker = 1;
  authorization = await signed();
  stub = env.PLAYLISTS.get(env.PLAYLISTS.idFromName("owner:7"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  await inside((app) => {
    app.schedule = async () => {};
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    const method = String(url).split("/").at(-1),
      input = JSON.parse(options.body);
    calls.push({ method, ...input });
    const failure = fail?.(method, input);
    if (failure instanceof Error) throw failure;
    if (failure) return Response.json({ ok: false, ...failure });
    let result = true;
    if (method === "getChatMember")
      result =
        input.chat_id < -9000
          ? { status: "administrator" }
          : {
              status: "administrator",
              can_post_messages: true,
              can_delete_messages: true,
            };
    if (method === "getChat")
      result = { id: input.chat_id, type: "channel", title: "Vault" };
    if (["sendAudio", "copyMessage", "sendMessage"].includes(method))
      result = { message_id: method === "sendMessage" && input.chat_id === -9001 ? vaultMarker : ++nextMessage };
    if (method === "forwardMessage")
      result = {
        message_id: ++nextMessage,
        audio: {
          file_unique_id: `scanned-${input.message_id}`,
          file_id: "scanned-file",
          title: "Scanned",
        },
      };
    return Response.json({ ok: true, result });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("Worker authentication and webhook", () => {
  it.each([
    {},
    { owner: 8 },
    { token: "wrong" },
    { authDate: 1 },
    { authDate: Math.floor(Date.now() / 1000) + 600 },
  ])("rejects invalid sessions %j", async (options) => {
    const auth = Object.keys(options).length ? await signed(options) : "";
    await api("GET", "/playlists", undefined, 401, auth);
  });

  it("requires the webhook secret, ignores other users, and deduplicates updates", async () => {
    await webhook({ update_id: 1 }, 403, "wrong");
    await command("/newplaylist Example", 2, { from: { id: 8 } });
    await command("/newplaylist Example", 3);
    await command("/newplaylist Example", 3);
    expect((await api("GET", "/playlists")).map((p) => p.name)).toEqual([
      "Example",
    ]);
    await drain();
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });

  it("opens the Mini App with an inline button on the deployed origin", async () => {
    await command("/start");
    await drain();
    expect(calls[0].reply_markup.inline_keyboard[0][0].web_app.url).toBe(
      "https://app.example",
    );
  });

  it("indexes live channel uploads and membership updates", async () => {
    await inside((app) => app.db.set("vault_chat_id", -9001));
    await webhook({
      update_id: 1,
      my_chat_member: {
        chat: { id: -1001, type: "channel", title: "Music" },
        new_chat_member: {
          status: "administrator",
          can_post_messages: true,
          can_delete_messages: true,
        },
      },
    });
    await webhook({
      update_id: 2,
      channel_post: {
        message_id: 5,
        chat: { id: -9001 },
        audio: { file_unique_id: "audio", file_id: "file", title: "Song" },
      },
    });
    expect((await api("GET", "/channels"))[0].title).toBe("Music");
    expect((await api("GET", "/tracks?q=song"))[0].title).toBe("Song");
  });

  it("serves health without exposing credentials and rejects unknown files", async () => {
    const health = await worker.fetch(
      new Request("https://app.example/health"),
      env,
    );
    expect(await health.json()).toEqual({ ok: true, runtime: "cloudflare" });
    for (const path of [
      "/.env",
      "/__init__.py",
      "/cloudflare/src/app.js",
      "/telegram/nope",
    ])
      expect(
        (await worker.fetch(new Request(`https://app.example${path}`), env))
          .status,
      ).toBe(404);
  });

  it("rejects duplicate signed fields and malformed JSON", async () => {
    await api(
      "GET",
      "/playlists",
      undefined,
      401,
      `${authorization}&auth_date=1`,
    );
    const response = await worker.fetch(
      new Request("https://app.example/api/playlists", {
        method: "POST",
        headers: { "X-Telegram-Init-Data": authorization },
        body: "{",
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_json");
  });

  it("fails clearly when deployment settings are missing or invalid", async () => {
    for (const overrides of [
      { OWNER_ID: "invalid" },
      { BOT_TOKEN: "" },
      { WEBHOOK_SECRET: "" },
      { PUBLISH_DELAY_SECONDS: "NaN" },
    ]) {
      const response = await worker.fetch(
        new Request("https://app.example/health"),
        { ...env, ...overrides },
      );
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("not_configured");
    }
  });

  it("wakes through the actual alarm binding and retains data after eviction", async () => {
    await inside((app) => {
      delete app.schedule;
      // Keep the automatic timer in the future; runDurableObjectAlarm triggers it now.
      app.db.enqueue(
        "notification",
        { chat_id: 7, text: "Alarm test" },
        3600000,
      );
    });
    await inside(async (app) => {
      await app.schedule();
      expect(await app.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
      app.db.exec("UPDATE tasks SET due_at=0");
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(calls.some((c) => c.text === "Alarm test")).toBe(true);
    expect(await inside((app) => app.ctx.storage.getAlarm())).toBe(null);
    await api("POST", "/playlists", { name: "Persisted" }, 201);
    await evictDurableObject(stub);
    expect((await api("GET", "/playlists"))[0].name).toBe("Persisted");
  }, 20000);
});

describe("playlist API and durable publishing", () => {
  it("creates, searches, reorders, publishes, clears, and deletes", async () => {
    const id = await seed();
    expect(
      (await api("GET", "/channels"))
        .map((c) => c.chat_id)
        .sort((a, b) => a - b),
    ).toEqual([-1002, -1001]);
    await api("PATCH", `/playlists/${id}`, { name: "Driving" });
    await api("PUT", `/playlists/${id}/order`, { track_ids: [3, 1, 2] });
    expect(
      (await api("GET", `/playlists/${id}`)).tracks.map((t) => t.id),
    ).toEqual([3, 1, 2]);
    const { job_id } = await api(
      "POST",
      `/playlists/${id}/publish`,
      undefined,
      202,
    );
    await api("PATCH", `/playlists/${id}`, { name: "Blocked" }, 409);
    await drain();
    expect(
      calls.filter((c) => c.method === "copyMessage").map((c) => c.message_id),
    ).toEqual([3, 1, 2]);
    expect((await api("GET", `/jobs/${job_id}`)).status).toBe("done");
    for (let i = 1; i <= 3; i++)
      await api("DELETE", `/playlists/${id}/tracks/${i}`);
    await api("POST", `/playlists/${id}/publish`, undefined, 202);
    await drain();
    expect(calls.filter((c) => c.method === "deleteMessages")).toHaveLength(1);
    await api("DELETE", `/playlists/${id}`);
    expect(await api("GET", "/playlists")).toEqual([]);
  });

  it("deletes a playlist and its published posts", async () => {
    const id = await seed();
    await api("POST", `/playlists/${id}/publish`, undefined, 202);
    await drain();
    await api("DELETE", `/playlists/${id}`);
    expect(await api("GET", "/playlists")).toEqual([]);
    expect(calls.filter((c) => c.method === "deleteMessages")).toHaveLength(1);
    expect(
      await inside(
        (app) => app.db.one("SELECT COUNT(*) n FROM published_messages").n,
      ),
    ).toBe(0);
  });

  it("keeps a playlist when its published posts cannot be deleted", async () => {
    const id = await seed();
    await api("POST", `/playlists/${id}/publish`, undefined, 202);
    await drain();
    fail = (method) =>
      method === "deleteMessages"
        ? { error_code: 400, description: "message can't be deleted" }
        : null;
    const { error } = await api("DELETE", `/playlists/${id}`, undefined, 409);
    expect(error).toContain("48 hours");
    await api("GET", `/playlists/${id}`);
    expect(
      await inside(
        (app) => app.db.one("SELECT COUNT(*) n FROM published_messages").n,
      ),
    ).toBe(3);
  });

  it.each(
    [[], null, { name: true }, { name: "" }, { name: "x".repeat(101) }].map(
      (input) => [input],
    ),
  )("rejects invalid create %j", async (input) => {
    await api("POST", "/playlists", input, 400);
  });

  it("rejects bad IDs, duplicate names, invalid reorder and a vault target", async () => {
    const id = await seed();
    await api("POST", "/playlists", { name: "Road trip" }, 409);
    for (const path of [
      "/playlists/nope",
      "/jobs/nope",
      "/tracks?limit=0",
      "/tracks?offset=-1",
    ])
      await api("GET", path, undefined, 400);
    for (const track_id of [true, "1", 1.5, null])
      await api("POST", `/playlists/${id}/tracks`, { track_id }, 400);
    await api("PUT", `/playlists/${id}/order`, { track_ids: [1, 1, 3] }, 400);
    expect(
      (await api("GET", `/playlists/${id}`)).tracks.map((t) => t.id),
    ).toEqual([1, 2, 3]);
    await api("PATCH", `/playlists/${id}`, { channel_id: -9001 }, 422);
  });

  it("deletes from the recorded channel after a playlist moves", async () => {
    const id = await seed();
    await api("POST", `/playlists/${id}/publish`, undefined, 202);
    await drain();
    await api("PATCH", `/playlists/${id}`, { channel_id: -1002 });
    await api("POST", `/playlists/${id}/publish`, undefined, 202);
    await drain();
    expect(calls.find((c) => c.method === "deleteMessages").chat_id).toBe(
      -1001,
    );
    expect(
      calls
        .filter((c) => c.method === "copyMessage")
        .slice(3)
        .every((c) => c.chat_id === -1002),
    ).toBe(true);
  });

  it("retains failed deletions and blocks posting", async () => {
    const id = await seed();
    await api("POST", `/playlists/${id}/publish`, undefined, 202);
    await drain();
    fail = (method) =>
      method === "deleteMessages"
        ? { error_code: 400, description: "message can't be deleted" }
        : null;
    const { job_id } = await api(
      "POST",
      `/playlists/${id}/publish`,
      undefined,
      202,
    );
    await drain();
    expect((await api("GET", `/jobs/${job_id}`)).error).toContain("48 hours");
    expect(calls.filter((c) => c.method === "copyMessage")).toHaveLength(3);
    expect(
      await inside(
        (app) => app.db.one("SELECT COUNT(*) n FROM published_messages").n,
      ),
    ).toBe(3);
  });

  it("refreshes permissions before deletion and does not mark audio missing", async () => {
    const id = await seed();
    fail = (method) =>
      method === "getChatMember"
        ? { error_code: 403, description: "kicked" }
        : null;
    const { job_id } = await api(
      "POST",
      `/playlists/${id}/publish`,
      undefined,
      202,
    );
    await drain();
    expect((await api("GET", `/jobs/${job_id}`)).status).toBe("error");
    expect(
      calls.some((c) =>
        ["deleteMessages", "copyMessage", "sendAudio"].includes(c.method),
      ),
    ).toBe(false);
    expect((await api("GET", "/tracks")).every((t) => !t.missing)).toBe(true);
  });

  it("falls back only for unavailable sources and skips only invalid files", async () => {
    const id = await seed();
    fail = (method, input) =>
      method === "copyMessage"
        ? { error_code: 400, description: "message to copy not found" }
        : method === "sendAudio" && input.audio === "file-2"
          ? {
              error_code: 400,
              description: "wrong file identifier/http url specified",
            }
          : null;
    const { job_id } = await api(
      "POST",
      `/playlists/${id}/publish`,
      undefined,
      202,
    );
    await drain();
    expect(await api("GET", `/jobs/${job_id}`)).toMatchObject({
      status: "done",
      progress: 3,
      skipped: 1,
      skipped_titles: ["Red"],
    });
    expect(
      (await api("GET", "/tracks")).filter((t) => t.missing).map((t) => t.id),
    ).toEqual([2]);
  });

  it("does not retry ambiguous copy timeouts", async () => {
    const id = await seed();
    fail = (method) => (method === "copyMessage" ? new Error("offline") : null);
    const { job_id } = await api(
      "POST",
      `/playlists/${id}/publish`,
      undefined,
      202,
    );
    await drain();
    expect(calls.filter((c) => c.method === "copyMessage")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "sendAudio")).toHaveLength(0);
    expect((await api("GET", `/jobs/${job_id}`)).error).toContain(
      "may have accepted",
    );
  });

  it("persists channel locks and blocks shared destinations", async () => {
    const id = await seed(),
      other = await api("POST", "/playlists", { name: "Other" }, 201);
    await api("PATCH", `/playlists/${other.id}`, { channel_id: -1001 });
    await api("POST", `/playlists/${other.id}/tracks`, { track_id: 1 });
    await api("POST", `/playlists/${id}/publish`, undefined, 202);
    await api("POST", `/playlists/${other.id}/publish`, undefined, 409);
    await drain();
    await api("POST", `/playlists/${other.id}/publish`, undefined, 202);
    await drain();
  });

  it("recovers after eviction and stops an uncertain in-flight send", async () => {
    const id = await seed();
    const { job_id } = await api(
      "POST",
      `/playlists/${id}/publish`,
      undefined,
      202,
    );
    await inside((app) => {
      app.db.exec("DELETE FROM tasks WHERE kind='notification'");
      app.db.exec(
        "UPDATE tasks SET inflight='copyMessage',due_at=? WHERE kind='publish'",
        Date.now() + 3600000,
      );
    });
    await evictDurableObject(stub);
    await inside((app) => {
      app.schedule = async () => {};
    });
    await drain();
    expect((await api("GET", `/jobs/${job_id}`)).status).toBe("interrupted");
    expect(calls.some((c) => c.method === "copyMessage")).toBe(false);
    expect(
      await inside(
        (app) => app.db.one("SELECT COUNT(*) n FROM channel_locks").n,
      ),
    ).toBe(0);
  });

  it("honors flood waits durably", async () => {
    const id = await seed();
    let once = true;
    fail = (method) =>
      method === "copyMessage" && once
        ? ((once = false),
          {
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 30 },
          })
        : null;
    await api("POST", `/playlists/${id}/publish`, undefined, 202);
    for (let i = 0; i < 10; i++) {
      await step();
      if (calls.some((c) => c.method === "copyMessage")) break;
    }
    expect(
      await inside(
        (app) => Number(app.db.setting("bot_not_before")) > Date.now() + 29000,
      ),
    ).toBe(true);
    await drain();
    expect(calls.filter((c) => c.method === "copyMessage")).toHaveLength(4);
  });

  it("retries safe permission failures with a bound and retains partial cleanup batches", async () => {
    const id = await seed();
    let remaining = 2;
    fail = (method) =>
      method === "getChatMember" && remaining-- > 0
        ? new Error("offline")
        : null;
    await api("POST", `/playlists/${id}/publish`, undefined, 202);
    await drain();
    expect(calls.filter((c) => c.method === "getChatMember")).toHaveLength(3);
    await inside((app) => {
      app.db.exec("DELETE FROM published_messages");
      for (let i = 0; i < 201; i++)
        app.db.exec(
          "INSERT INTO published_messages(playlist_id,chat_id,message_id,published_at) VALUES(?,?,?,?)",
          id,
          -1001,
          1000 + i,
          new Date().toISOString(),
        );
    });
    let batches = 0;
    fail = (method) =>
      method === "deleteMessages" && ++batches > 1
        ? new Error("offline")
        : null;
    const { job_id } = await api(
      "POST",
      `/playlists/${id}/publish`,
      undefined,
      202,
    );
    await drain();
    expect((await api("GET", `/jobs/${job_id}`)).status).toBe("error");
    expect(
      calls
        .filter((c) => c.method === "deleteMessages")
        .map((c) => c.message_ids.length),
    ).toEqual([100, 100, 100, 100, 100]);
    expect(
      await inside(
        (app) => app.db.one("SELECT COUNT(*) n FROM published_messages").n,
      ),
    ).toBe(101);
  });
});

describe("cancelling work", () => {
  it("cancels running scans and publishes", async () => {
    const id = await seed();
    await inside((app) => app.startScan(-9001, true, 3));
    const { job_id } = await api(
      "POST",
      `/playlists/${id}/publish`,
      undefined,
      202,
    );
    await command("/cancel");
    expect(await inside((app) => app.db.setting("scan_state"))).toBe("idle");
    expect(
      await inside(
        (app) =>
          app.db.one("SELECT status FROM jobs WHERE id=?", job_id).status,
      ),
    ).toBe("cancelled");
    expect(
      await inside(
        (app) =>
          app.db.one(
            "SELECT COUNT(*) n FROM tasks WHERE kind IN ('scan','publish')",
          ).n,
      ),
    ).toBe(0);
    expect(
      await inside((app) => app.db.one("SELECT COUNT(*) n FROM channel_locks").n),
    ).toBe(0);
    await drain();
    expect(
      calls.some(
        (c) =>
          c.method === "sendMessage" &&
          c.text.includes("Cancelled all running work"),
      ),
    ).toBe(true);
  });

  it("reports when nothing is running", async () => {
    await command("/cancel");
    await drain();
    expect(
      calls.some(
        (c) => c.method === "sendMessage" && c.text === "Nothing to cancel.",
      ),
    ).toBe(true);
  });
});

describe("durable vault scanning", () => {
  it("validates a forwarded vault, indexes audio, skips gaps and cleans DMs", async () => {
    nextMessage = 3;
    fail = (method, input) =>
      method === "forwardMessage" && input.message_id === 2
        ? { error_code: 400, description: "message to forward not found" }
        : null;
    // Start directly so the scan maximum is deterministic.
    await inside((app) => app.startScan(-9001, true, 3));
    await drain();
    expect((await api("GET", "/tracks")).map((t) => t.title)).toEqual([
      "Scanned",
      "Scanned",
    ]);
    expect(
      await inside((app) => ({
        state: app.db.setting("scan_state"),
        cursor: app.db.setting("scan_cursor"),
      })),
    ).toEqual({ state: "done", cursor: "3" });
    expect(
      calls
        .filter((c) => c.method === "deleteMessages" && c.chat_id === 7)
        .map((c) => c.message_ids),
    ).toEqual([[4, 5]]);
    expect(
      calls.filter((c) => c.method === "deleteMessage" && c.chat_id === 7),
    ).toHaveLength(0);
    await command("/setvault", 1);
    await command("", 2, {
      forward_origin: { chat: { id: -9002, type: "channel" }, message_id: 4 },
    });
    // Process just the selection checks; the scan is exercised above.
    for (let i = 0; i < 5; i++) {
      if ((await inside((app) => app.db.setting("vault_chat_id"))) === "-9002")
        break;
      await step();
    }
    expect(await inside((app) => app.db.setting("vault_chat_id"))).toBe(
      "-9002",
    );
  });

  it("accepts a read-only vault and never writes to it", async () => {
    await command("/setvault");
    await command("", 2, {
      forward_origin: { chat: { id: -9002, type: "channel" }, message_id: 2 },
    });
    await drain();
    expect(await inside((app) => app.db.setting("vault_chat_id"))).toBe("-9002");
    expect(await inside((app) => app.db.setting("scan_state"))).toBe("done");
    expect(
      calls.filter(
        (c) =>
          ["sendMessage", "deleteMessage", "deleteMessages"].includes(
            c.method,
          ) && c.chat_id === -9002,
      ),
    ).toEqual([]);
  });

  it("does not advance the cursor on a network failure and resumes", async () => {
    nextMessage = 2;
    fail = (method) =>
      method === "forwardMessage" ? new Error("offline") : null;
    await inside((app) => app.startScan(-9001, true, 2));
    await drain();
    expect(await inside((app) => app.db.setting("scan_cursor"))).toBe("0");
    expect(await inside((app) => app.db.setting("scan_state"))).toBe("error");
    fail = null;
    await command("/resumescan");
    await drain();
    expect(await inside((app) => app.db.setting("scan_state"))).toBe("done");
    expect((await api("GET", "/tracks")).length).toBe(2);
  });

  it("retains verified sources after switching the vault", async () => {
    const id = await seed();
    await inside((app) => app.db.set("vault_chat_id", -9002));
    expect(await api("GET", "/tracks")).toEqual([]);
    await api("POST", `/playlists/${id}/publish`, undefined, 202);
    await drain();
    expect(
      calls
        .filter((c) => c.method === "copyMessage")
        .every((c) => c.from_chat_id === -9001),
    ).toBe(true);
  });

  it("retains forwarded message cleanup across failures and eviction", async () => {
    nextMessage = 1;
    fail = (method, input) =>
      method === "deleteMessages" && input.chat_id === 7
        ? new Error("offline")
        : null;
    await inside((app) => app.startScan(-9001, true, 1));
    await drain();
    expect(await inside((app) => app.db.setting("scan_cursor"))).toBe("1");
    expect(await inside((app) => app.db.setting("scan_pending"))).toBe("[2]");
    fail = null;
    await command("/resumescan");
    await inside((app) => {
      app.db.exec("UPDATE tasks SET due_at=?", Date.now() + 3600000);
      app.db.set("bot_not_before", Date.now() + 3600000);
    });
    await evictDurableObject(stub);
    await inside((app) => {
      app.schedule = async () => {};
    });
    await drain();
    expect(await inside((app) => app.db.setting("scan_state"))).toBe("done");
    expect(await inside((app) => app.db.setting("scan_cursor"))).toBe("1");
    expect(await inside((app) => app.db.setting("scan_pending"))).toBe("[]");
    expect(calls.filter((c) => c.method === "forwardMessage")).toHaveLength(1);
  }, 20000);

  it("rejects protected vaults without changing the selected vault", async () => {
    await inside((app) => app.db.set("vault_chat_id", -9001));
    vi.mocked(fetch).mockImplementation(async () =>
      Response.json({
        ok: true,
        result: { type: "channel", has_protected_content: true },
      }),
    );
    await command("/setvault");
    await command("", 2, {
      forward_origin: { chat: { id: -9002, type: "channel" }, message_id: 4 },
    });
    await drain();
    expect(await inside((app) => app.db.setting("vault_chat_id"))).toBe(
      "-9001",
    );
    expect(await inside((app) => app.db.setting("pending_vault"))).toBe("1");
  });
});

async function syncTo(max, update = 100) {
  vaultMarker = max + 1;
  await command("/syncvault", update);
  for (let i = 0; i < 10 && !(await inside((app) => app.db.one("SELECT 1 FROM tasks WHERE kind='scan'"))); i++) await step();
}

describe("incremental synchronization", () => {
  it("requires a vault and starts without a forwarded message", async () => {
    await command("/syncvault");
    await inside((app) => app.db.set("vault_chat_id", -9001));
    await syncTo(2, 2);
    await drain();
    expect(calls.some((c) => c.method === "sendMessage" && c.chat_id === -9001)).toBe(true);
    expect(calls.some((c) => c.method === "deleteMessage" && c.chat_id === -9001 && c.message_id === 3)).toBe(true);
    expect(await inside((app) => app.db.checkpoint(-9001))).toBe(2);
  });

  it("reports missing vault permissions without starting a scan", async () => {
    await inside((app) => app.db.set("vault_chat_id", -9001));
    fail = (method, input) => method === "sendMessage" && input.chat_id === -9001
      ? { error_code: 403, description: "not enough rights" } : null;
    await command("/vaultsync");
    await drain();
    expect(await inside((app) => app.scanBusy())).toBe(false);
    expect(calls.some((c) => c.chat_id === 7 && c.text?.includes("Post Messages and Delete Messages"))).toBe(true);
  });

  it("covers gaps and non-audio, reuses live audio, and keeps a fixed bound", async () => {
    await inside((app) => {
      app.db.set("vault_chat_id", -9001);
      app.db.set("scan_cursor", 2);
    });
    await webhook({ update_id: 10, channel_post: {
      chat: { id: -9001 }, message_id: 4,
      audio: { file_unique_id: "live", file_id: "live-file" },
    } });
    fail = (method, input) => method === "forwardMessage" && input.message_id === 3
      ? { error_code: 400, description: "message to forward not found" } : null;
    const original = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      const result = await original(url, options);
      if (String(url).endsWith("/forwardMessage") && JSON.parse(options.body).message_id === 5)
        return Response.json({ ok: true, result: { message_id: ++nextMessage, text: "No audio" } });
      return result;
    });
    await syncTo(5);
    await webhook({ update_id: 200, channel_post: {
      chat: { id: -9001 }, message_id: 9,
      audio: { file_unique_id: "later", file_id: "later-file" },
    } });
    await drain();
    expect(calls.filter((c) => c.method === "forwardMessage").map((c) => c.message_id)).toEqual([3, 5]);
    expect(await inside((app) => app.db.checkpoint(-9001))).toBe(5);
    await syncTo(5, 300);
    await drain();
    expect(calls.filter((c) => c.method === "forwardMessage")).toHaveLength(2);
    expect(await inside((app) => app.db.checkpoint(-9001))).toBe(5);
  });

  it("never infers coverage from indexed tracks and fully refreshes on rescan", async () => {
    await seed();
    await syncTo(3);
    await drain();
    expect(calls.filter((c) => c.method === "forwardMessage")).toHaveLength(0);
    expect(await inside((app) => app.db.checkpoint(-9001))).toBe(3);
    await command("/rescan", 200);
    await drain();
    expect(calls.filter((c) => c.method === "forwardMessage").map((c) => c.message_id)).toEqual([1, 2, 3]);
    expect(await inside((app) => app.db.checkpoint(-9001))).toBe(3);
  });

  it("retains confirmed metadata and coverage when a later forward fails", async () => {
    await inside((app) => app.startScan(-9001, true, 3));
    fail = (method, input) => method === "forwardMessage" && input.message_id === 2
      ? new Error("offline") : null;
    await drain();
    expect(await inside((app) => app.db.checkpoint(-9001))).toBe(1);
    expect(await inside((app) => app.db.setting("scan_pending"))).toBe("[101]");
    expect((await api("GET", "/tracks"))).toHaveLength(1);
    fail = null;
    await command("/resumescan");
    await drain();
    expect(calls.filter((c) => c.method === "forwardMessage").map((c) => c.message_id)).toEqual([1, 2, 2, 3]);
    expect(await inside((app) => app.db.checkpoint(-9001))).toBe(3);
  });

  it("retains each confirmed forward through eviction and cleans only after ten", async () => {
    await inside((app) => app.startScan(-9001, true, 11));
    for (let i = 0; i < 9; i++) {
      const count = calls.length;
      await step();
      expect(calls.length - count).toBe(1);
    }
    expect(calls.some((c) => c.method === "deleteMessages")).toBe(false);
    await inside((app) => app.db.exec("UPDATE tasks SET due_at=?", Date.now() + 3600000));
    await evictDurableObject(stub);
    await inside((app) => { app.schedule = async () => {}; });
    await step();
    expect(calls.at(-1).method).toBe("forwardMessage");
    await step();
    expect(calls.at(-1).message_ids).toHaveLength(10);
    await drain();
    expect(calls.filter((c) => c.method === "forwardMessage").map((c) => c.message_id))
      .toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    expect(await inside((app) => app.db.checkpoint(-9001))).toBe(11);
  }, 20000);

  it("stops an uncertain forward after eviction without replaying it", async () => {
    await inside((app) => {
      app.startScan(-9001, true, 2);
      app.db.exec("UPDATE tasks SET inflight='forwardMessage',due_at=?", Date.now() + 3600000);
    });
    await evictDurableObject(stub);
    await inside((app) => { app.schedule = async () => {}; });
    await drain();
    expect(calls.some((c) => c.method === "forwardMessage")).toBe(false);
    expect(await inside((app) => app.db.setting("scan_state"))).toBe("error");
    expect(await inside((app) => app.db.checkpoint(-9001))).toBe(0);
  }, 20000);

  it("migrates only the current vault's cursor and retains independent checkpoints", async () => {
    await inside((app) => {
      app.db.set("vault_chat_id", -9001);
      app.db.set("scan_cursor", 8);
      app.db.enqueue("notification", { chat_id: 7, text: "Pending" }, 3600000);
    });
    await evictDurableObject(stub);
    await inside((app) => {
      app.schedule = async () => {};
      expect(app.db.checkpoint(-9001)).toBe(8);
      expect(app.db.checkpoint(-9002)).toBe(0);
      expect(app.db.one("SELECT COUNT(*) n FROM tasks").n).toBe(1);
      app.startScan(-9002, true, 2);
    });
    await drain();
    expect(await inside((app) => app.db.checkpoint(-9001))).toBe(8);
    expect(await inside((app) => app.db.checkpoint(-9002))).toBe(2);
  }, 20000);

  it("benchmarks 1000 initial IDs then inspects only 20 new IDs with live cache reuse", async () => {
    await inside((app) => app.startScan(-9001, true, 1000));
    await drain();
    expect(calls.filter((c) => c.method === "forwardMessage")).toHaveLength(1000);
    expect(calls.filter((c) => c.method === "deleteMessages")).toHaveLength(100);
    await inside((app) => {
      for (let id = 1001; id <= 1010; id++) app.db.index({
        chat: { id: -9001 }, message_id: id,
        audio: { file_unique_id: `live-${id}`, file_id: `file-${id}` },
      });
    });
    calls.length = 0;
    await syncTo(1020);
    await drain();
    expect(calls.filter((c) => c.method === "forwardMessage").map((c) => c.message_id))
      .toEqual(Array.from({ length: 10 }, (_, i) => i + 1011));
    expect(calls.filter((c) => c.method === "deleteMessages")).toHaveLength(1);
    expect(await inside((app) => app.db.checkpoint(-9001))).toBe(1020);
    expect(await inside((app) => app.db.one("SELECT COUNT(*) n FROM tracks").n)).toBe(1020);
  }, 30000);
});

describe("destination pacing and scheduler eligibility", () => {
  it("defaults publishing to 1.1 seconds and respects configured overrides", async () => {
    await inside((app) => {
      app.env = { ...app.env, PUBLISH_DELAY_SECONDS: undefined };
      expect(app.pacing(-1001).floor).toBe(1100);
      app.env.PUBLISH_DELAY_SECONDS = "3";
      expect(app.pacing(-1001).floor).toBe(3000);
      app.env.PUBLISH_DELAY_SECONDS = "0.5";
      expect(app.pacing(-1001).floor).toBe(500);
      expect(app.pacing(7).floor).toBe(1100);
    });
  });

  it("enforces the owner cooldown across notifications and scan forwards", async () => {
    await inside((app) => {
      app.notify("First");
      app.notify("Second");
      app.startScan(-9001, true, 1);
    });
    await inside(async (app) => {
      await app.alarm();
      expect(calls).toHaveLength(1);
      expect(app.pacing(7).until).toBeGreaterThanOrEqual(Date.now() + 1000);
      await app.alarm();
      expect(calls).toHaveLength(1);
      const now = app.pacing(7).until;
      const time = vi.spyOn(Date, "now").mockReturnValue(now);
      await app.alarm();
      expect(calls).toHaveLength(2);
      expect(calls.at(-1).text).toBe("Second");
      await app.alarm();
      expect(calls).toHaveLength(2);
      time.mockReturnValue(app.pacing(7).until);
      await app.alarm();
      expect(calls.at(-1).method).toBe("forwardMessage");
      expect(calls).toHaveLength(3);
      // Cleanup and completion do not send a new message to the owner.
      await app.alarm();
      expect(calls.at(-1).method).toBe("deleteMessages");
      time.mockRestore();
    });
  });

  it("runs ready publishing while the owner is cooling and persists the earliest alarm", async () => {
    const id = await seed();
    await api("POST", `/playlists/${id}/publish`, undefined, 202);
    await inside((app) => {
      app.db.set("chat_pacing:7", JSON.stringify({ until: Date.now() + 60000 }));
    });
    for (let i = 0; i < 4; i++) await inside((app) => app.alarm());
    expect(calls.some((c) => c.method === "copyMessage")).toBe(true);
    expect(calls.some((c) => c.method === "sendMessage")).toBe(false);
    await inside(async (app) => {
      app.db.set("chat_pacing:-1001", JSON.stringify({ until: Date.now() + 30000 }));
      delete app.schedule;
      await app.schedule();
      const alarm = await app.ctx.storage.getAlarm();
      expect(alarm).toBe(app.pacing(-1001).until);
      await app.alarm();
      expect(await app.ctx.storage.getAlarm()).toBe(alarm);
      app.schedule = async () => {};
    });
  });

  it("allows another channel to send while one channel cools, retaining playlist order", async () => {
    const id = await seed();
    const other = await api("POST", "/playlists", { name: "Second" }, 201);
    await api("PATCH", `/playlists/${other.id}`, { channel_id: -1002 });
    for (const track_id of [3, 2, 1]) await api("POST", `/playlists/${other.id}/tracks`, { track_id });
    await api("POST", `/playlists/${id}/publish`, undefined, 202);
    await api("POST", `/playlists/${other.id}/publish`, undefined, 202);
    await inside((app) => {
      app.db.set("chat_pacing:-1001", JSON.stringify({ until: Date.now() + 60000 }));
      app.db.set("chat_pacing:7", JSON.stringify({ until: Date.now() + 60000 }));
    });
    for (let i = 0; i < 20; i++) await inside((app) => app.alarm());
    expect(calls.filter((c) => c.method === "copyMessage").map((c) => [c.chat_id, c.message_id]))
      .toEqual([[-1002, 3], [-1002, 2], [-1002, 1]]);
    await drain();
    expect(calls.filter((c) => c.method === "copyMessage" && c.chat_id === -1001).map((c) => c.message_id))
      .toEqual([1, 2, 3]);
  });

  it("doubles only the affected chat interval, caps it, and restores its floor after 20 successes", async () => {
    await inside((app) => {
      app.env = { ...app.env, PUBLISH_DELAY_SECONDS: "1.1" };
      app.db.enqueue("notification", { chat_id: -1001, text: "Paced" });
    });
    fail = () => ({ error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } });
    for (const interval of [2200, 4400, 5000, 5000]) {
      await step();
      await inside(async (app) => {
        expect(app.pacing(-1001).interval).toBe(interval);
        expect(app.pacing(-1002).interval).toBe(1100);
        expect(app.pacing(7).interval).toBe(1100);
        expect(Number(app.db.setting("bot_not_before"))).toBeGreaterThan(Date.now() + 29000);
        const count = calls.length;
        await app.alarm();
        expect(calls).toHaveLength(count);
      });
    }
    fail = null;
    await step();
    for (let i = 1; i < 20; i++) {
      await inside((app) => app.db.enqueue("notification", { chat_id: -1001, text: "Success" }));
      await step();
      expect(await inside((app) => app.pacing(-1001).interval)).toBe(i === 19 ? 1100 : 5000);
    }
  });

  it("keeps configured floors above five seconds during backoff", async () => {
    await inside((app) => {
      app.env = { ...app.env, PUBLISH_DELAY_SECONDS: "8" };
      app.db.enqueue("notification", { chat_id: -1001, text: "Slow" });
    });
    fail = () => ({ error_code: 429, parameters: { retry_after: 1 } });
    await step();
    expect(await inside((app) => app.pacing(-1001).interval)).toBe(8000);
  });

  it("retains cooldowns through eviction and cancellation retains cleanup IDs", async () => {
    await inside((app) => app.startScan(-9001, true, 3));
    await step();
    const until = await inside((app) => app.pacing(7).until);
    await command("/cancel");
    expect(await inside((app) => app.db.setting("scan_pending"))).toBe("[101]");
    await inside((app) => app.db.exec("UPDATE tasks SET due_at=?", Date.now() + 3600000));
    await evictDurableObject(stub);
    await inside((app) => {
      app.schedule = async () => {};
      expect(app.pacing(7).until).toBe(until);
    });
    await command("/resumescan", 2);
    await drain();
    expect(calls.filter((c) => c.method === "forwardMessage").map((c) => c.message_id)).toEqual([1, 2, 3]);
    expect(await inside((app) => app.db.setting("scan_pending"))).toBe("[]");
  }, 20000);
});

describe("scan commit failures", () => {
  it("rolls back metadata, cleanup IDs and cursor together if checkpointing fails", async () => {
    await inside(async (app) => {
      app.startScan(-9001, true, 1);
      const update = vi.spyOn(app.db, "updateTask").mockImplementation(() => {
        throw new Error("Simulated failure before commit");
      });
      await app.alarm();
      update.mockRestore();
      expect(app.db.one("SELECT COUNT(*) n FROM tracks").n).toBe(0);
      expect(app.db.setting("scan_cursor")).toBe("0");
      expect(app.db.checkpoint(-9001)).toBe(0);
      expect(app.db.setting("scan_pending", "[]")).toBe("[]");
      expect(app.db.setting("scan_error")).toContain("may have accepted");
    });
    await drain();
    expect(calls.filter((c) => c.method === "forwardMessage")).toHaveLength(1);
  });

  it("does not reuse a matching message ID from another vault", async () => {
    await inside((app) => {
      app.db.set("vault_chat_id", -9001);
      app.db.index({ chat: { id: -9002 }, message_id: 1,
        audio: { file_unique_id: "different-vault", file_id: "other" } });
    });
    await syncTo(1);
    await drain();
    expect(calls.filter((c) => c.method === "forwardMessage")).toHaveLength(1);
    expect(await inside((app) => app.db.checkpoint(-9001))).toBe(1);
  });
});

describe("owner task fairness", () => {
  it("delivers a waiting status notification before the next scan forward", async () => {
    await inside(async (app) => {
      app.startScan(-9001, true, 3);
      await app.alarm();
      app.notify("Scan status");
      // Both tasks share the owner's next eligible send time. Prefer the
      // notification that was due before the scan's most recent progress.
      app.db.exec("UPDATE tasks SET due_at=? WHERE kind='notification'", Date.now() - 10);
      const time = vi.spyOn(Date, "now").mockReturnValue(app.pacing(7).until);
      await app.alarm();
      time.mockRestore();
    });
    expect(calls.map((c) => c.method)).toEqual(["forwardMessage", "sendMessage"]);
    expect(calls.at(-1).text).toBe("Scan status");
  });
});

describe("database maintenance", () => {
  it("only prunes source metadata when a scan confirms it is gone", async () => {
    await seed();
    await inside(async (app) => {
      app.db.exec("DELETE FROM playlist_tracks");
      app.startScan(-9001, true, 3);
      const original = app.call;
      app.call = async (task, method, input) => {
        if (method !== "forwardMessage") return true;
        if (input.message_id === 1)
          throw new TelegramError("message can't be forwarded", 400);
        if (input.message_id === 2)
          throw new TelegramError("message to forward not found", 400);
        return { message_id: 103, text: "No audio" };
      };
      try {
        for (let i = 0; i < 10; i++) {
          const task = app.db.one("SELECT * FROM tasks WHERE kind='scan'");
          if (!task) break;
          await app.scanStep(task, JSON.parse(task.payload));
        }
      } finally {
        app.call = original;
      }
      expect(app.db.all("SELECT id FROM tracks")).toEqual([{ id: 1 }]);
      expect(app.db.setting("scan_state")).toBe("done");
    });
  });

  it("keeps the latest publish result and active snapshots while pruning unused tracks", async () => {
    const pid = await seed();
    await inside((app) => {
      const db = app.db;
      for (const [unique, source, missing] of [["old", -9002, 0], ["missing", -9001, 1], ["snapshot", -9002, 0]]) {
        db.index({ chat: { id: source }, message_id: 50, audio: { file_unique_id: unique, file_id: unique } });
        db.exec("UPDATE tracks SET missing=? WHERE file_unique_id=?", missing, unique);
      }
      const track = db.one("SELECT id FROM tracks WHERE file_unique_id='snapshot'").id;
      for (const status of ["done", "error", "running"])
        db.exec("INSERT INTO jobs(playlist_id,status,current_track,created_at,updated_at,state) VALUES(?,?,?,?,?,?)",
          pid, status, "Snapshot", "today", "today", JSON.stringify({ tracks: [track] }));
      db.prune();
      expect(db.all("SELECT status,state,current_track FROM jobs ORDER BY id")).toEqual([
        { status: "error", state: "{}", current_track: null },
        { status: "running", state: JSON.stringify({ tracks: [track] }), current_track: "Snapshot" },
      ]);
      expect(db.all("SELECT file_unique_id FROM tracks ORDER BY id").map((r) => r.file_unique_id)).toEqual(["unique-1", "unique-2", "unique-3", "snapshot"]);
      expect(db.tracks(pid)).toHaveLength(3);
      db.exec("UPDATE jobs SET status='done' WHERE status='running'");
      db.prune();
      expect(db.one("SELECT COUNT(*) n FROM jobs").n).toBe(1);
      expect(db.one("SELECT 1 FROM tracks WHERE file_unique_id='snapshot'")).toBe(null);
    });
  });

  it("prunes confirmed deleted sources while preserving published references and the current library", async () => {
    const pid = await seed();
    await inside((app) => {
      const db = app.db;
      db.exec("DELETE FROM playlist_tracks WHERE track_id IN (2,3)");
      db.exec("INSERT INTO published_messages(playlist_id,chat_id,message_id,track_id,published_at) VALUES(?,-1001,100,2,'today')", pid);
      db.pruneSource(-9001, 1);
      db.pruneSource(-9001, 2);
      db.prune();
      expect(db.one("SELECT COUNT(*) n FROM tracks").n).toBe(3);
      db.pruneSource(-9001, 3);
      expect(db.one("SELECT COUNT(*) n FROM tracks").n).toBe(2);
      expect(db.one("SELECT COUNT(*) n FROM published_messages").n).toBe(1);
    });
  });

  it("expires webhook receipts on an idle maintenance alarm and schedules the next cleanup", async () => {
    await inside(async (app) => {
      app.db.exec("INSERT INTO updates VALUES(?,?)", 1, Date.now() - 8 * 86400000);
      app.db.exec("INSERT INTO updates VALUES(?,?)", 2, Date.now());
      for (const chat of [7, -8000])
        app.db.set(`chat_pacing:${chat}`, JSON.stringify({ until: 0, interval: 2200 }));
      app.db.set("maintenance_at", "0");
      delete app.schedule;
      await app.alarm();
      expect(app.db.all("SELECT id FROM updates")).toEqual([{ id: 2 }]);
      expect(app.db.setting("chat_pacing:-8000")).toBe(null);
      expect(JSON.parse(app.db.setting("chat_pacing:7")).interval).toBe(2200);
      const alarm = await app.ctx.storage.getAlarm();
      expect(alarm).toBeGreaterThan(Date.now());
      expect(alarm).toBe(app.db.maintenanceDue());
    });
  });
});
