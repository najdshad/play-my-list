// Run through npm scripts; credentials come from the ignored .dev.vars file.
const [action, address] = process.argv.slice(2);
const token = process.env.BOT_TOKEN;
if (!token) throw new Error("Set BOT_TOKEN in .dev.vars first.");

const commands = [
  { command: "start", description: "Open the playlist app" },
  { command: "help", description: "Show setup and command help" },
  { command: "setvault", description: "Choose the vault channel" },
  { command: "scanstatus", description: "Show scan progress" },
  { command: "syncvault", description: "Check the vault for new tracks" },
  { command: "rescan", description: "Rescan the vault from the start" },
  { command: "resumescan", description: "Resume a failed scan" },
  { command: "newplaylist", description: "Create a playlist by name" },
  { command: "list", description: "List playlists" },
  { command: "publish", description: "Publish a playlist by name" },
  { command: "cancel", description: "Cancel running scans and publishing" },
];

async function call(method, parameters = {}) {
  let data;
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parameters),
        signal: AbortSignal.timeout(15000),
      },
    );
    data = await response.json();
  } catch {
    throw new Error("Could not reach Telegram. Check your network connection.");
  }
  if (!data.ok)
    throw new Error(data.description || "Telegram rejected the request.");
  return data.result;
}

try {
  if (action === "setup") {
    const url = new URL(address);
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("Supply the root HTTPS Worker URL.");
    const secret = process.env.WEBHOOK_SECRET;
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret || ""))
      throw new Error(
        "Set a random WEBHOOK_SECRET (16–256 letters, digits, underscores or hyphens) in .dev.vars.",
      );
    const health = await fetch(new URL("/health", url), {
      signal: AbortSignal.timeout(15000),
    });
    const status = await health.json();
    if (!health.ok || status.runtime !== "cloudflare")
      throw new Error(
        "Deploy and configure the Worker before registering its webhook.",
      );
    await call("setWebhook", {
      url: new URL("/telegram/webhook", url).href,
      secret_token: secret,
      max_connections: 1,
      allowed_updates: [
        "message",
        "channel_post",
        "edited_channel_post",
        "my_chat_member",
      ],
      drop_pending_updates: false,
    });
    await call("setMyCommands", { commands });
    await call("setMyDescription", {
      description: "Turn your Telegram music channel into playlists. Index tracks from your vault, organize them in the Mini App, and publish playlists to your channels. Send /start to get started or /help for commands.",
    });
    await call("setMyShortDescription", {
      short_description: "Organize music from your Telegram vault and publish playlists to your channels.",
    });
    console.log(
      "Webhook registered; command menu and bot descriptions updated. Stop the Python polling process before testing this bot.",
    );
  } else if (action !== "status")
    throw new Error("Use setup <https-worker-url> or status.");
  const info = await call("getWebhookInfo");
  console.log(
    JSON.stringify(
      {
        url: info.url,
        pending_update_count: info.pending_update_count,
        last_error_message: info.last_error_message ?? null,
      },
      null,
      2,
    ),
  );
} catch (error) {
  // Avoid logging network exception causes: they can contain a token-bearing URL.
  console.error(
    error.message?.includes(token) ? "Telegram setup failed." : error.message,
  );
  process.exitCode = 1;
}
