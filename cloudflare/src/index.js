import {
  authenticate,
  body,
  configuration,
  constantEqual,
  errorResponse,
  json,
  AppError,
} from "./auth.js";
export { PlaylistApp } from "./app.js";

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/health") {
        configuration(env);
        return json({ ok: true, runtime: "cloudflare" });
      }
      if (
        path === "/api" ||
        path.startsWith("/api/") ||
        path === "/telegram/webhook"
      ) {
        const owner = configuration(env);
        if (path === "/telegram/webhook") {
          if (request.method !== "POST")
            throw new AppError("Method not allowed.", 405, "http_error");
          if (
            !constantEqual(
              request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "",
              env.WEBHOOK_SECRET,
            )
          )
            throw new AppError("Invalid webhook secret.", 403, "forbidden");
          // Parse before forwarding, enforcing the same body contract at the edge.
          await body(request.clone());
        } else
          await authenticate(
            request.headers.get("X-Telegram-Init-Data"),
            env.BOT_TOKEN,
            owner,
          );
        const stub = env.PLAYLISTS.get(
          env.PLAYLISTS.idFromName(`owner:${owner}`),
        );
        return await stub.fetch(request);
      }
      if (
        ["/", "/index.html", "/app.js", "/style.css"].includes(path) &&
        ["GET", "HEAD"].includes(request.method)
      )
        return env.ASSETS.fetch(request);
      return json({ error: "Not found.", code: "not_found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  },
};
