const encoder = new TextEncoder();

export class AppError extends Error {
  constructor(message, status = 400, code = "invalid_input") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function hmac(key, value) {
  const imported = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, encoder.encode(value));
}

export function constantEqual(left, right) {
  const a = encoder.encode(left),
    b = encoder.encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

export async function authenticate(initData, token, owner) {
  const fail = () => {
    throw new AppError(
      "Close this app and reopen it from the bot.",
      401,
      "unauthorized",
    );
  };
  const fields = new URLSearchParams(initData || "");
  // Duplicate signed fields are ambiguous and are never accepted.
  if (new Set(fields.keys()).size !== [...fields.keys()].length) fail();
  const hash = fields.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) fail();
  fields.delete("hash");
  const check = [...fields.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac("WebAppData", token);
  const signed = new Uint8Array(await hmac(secret, check));
  const expected = [...signed]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  if (!constantEqual(hash, expected)) fail();
  let user;
  try {
    user = JSON.parse(fields.get("user"));
  } catch {
    fail();
  }
  const date = Number(fields.get("auth_date")),
    now = Date.now() / 1000;
  if (
    !Number.isSafeInteger(date) ||
    date <= 0 ||
    now - date > 86400 ||
    date > now + 60 ||
    user?.id !== owner
  )
    fail();
}

export function configuration(env) {
  const owner = Number(env.OWNER_ID);
  if (
    !Number.isSafeInteger(owner) ||
    owner <= 0 ||
    !/^\d+:[A-Za-z0-9_-]+$/.test(env.BOT_TOKEN || "") ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(env.WEBHOOK_SECRET || "")
  ) {
    throw new AppError(
      "Configure OWNER_ID, BOT_TOKEN and WEBHOOK_SECRET before using the app.",
      503,
      "not_configured",
    );
  }
  for (const name of ["PUBLISH_DELAY_SECONDS", "SCAN_DELAY_SECONDS"]) {
    if (
      env[name] !== undefined &&
      (!Number.isFinite(Number(env[name])) || Number(env[name]) < 0)
    ) {
      throw new AppError(
        `${name} must be finite and non-negative.`,
        503,
        "not_configured",
      );
    }
  }
  if (env.WEB_APP_URL) {
    let url;
    try {
      url = new URL(env.WEB_APP_URL);
    } catch {}
    if (url?.protocol !== "https:" || url.username || url.password) {
      throw new AppError(
        "WEB_APP_URL must be a public HTTPS URL.",
        503,
        "not_configured",
      );
    }
  }
  return owner;
}

export function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function errorResponse(error) {
  if (error instanceof AppError)
    return json({ error: error.message, code: error.code }, error.status);
  if (/UNIQUE constraint failed: playlists.name/.test(String(error)))
    return json(
      { error: "That playlist name is already in use.", code: "duplicate" },
      409,
    );
  // Telegram URLs contain the bot token. Never log raw fetch exceptions or requests.
  console.error("Request failed", error?.name || "Error");
  return json(
    {
      error: "An unexpected error occurred. Please retry.",
      code: "internal_error",
    },
    500,
  );
}

export async function body(request) {
  if (Number(request.headers.get("Content-Length")) > 1024 * 1024)
    throw new AppError("Request too large.", 413);
  let value;
  try {
    value = await request.json();
  } catch {
    throw new AppError("Send a valid JSON object.", 400, "invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("The request body must be a JSON object.");
  return value;
}

export function integer(value, label, minimum = Number.MIN_SAFE_INTEGER) {
  if (typeof value === "string" && /^-?\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new AppError(
      `${label} must be an integer${minimum > 0 ? ` of at least ${minimum}` : ""}.`,
    );
  return value;
}

export function playlistName(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value.trim()].length > 100
  )
    throw new AppError("Playlist name must be 1–100 characters.");
  return value.trim();
}
