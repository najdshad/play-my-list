import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Keep tests independent of .env/.dev.vars and real bot credentials.
      main: "./cloudflare/src/index.js",
      miniflare: {
        compatibilityDate: "2026-10-28",
        durableObjects: {
          PLAYLISTS: { className: "PlaylistApp", useSQLite: true },
        },
        bindings: {
          BOT_TOKEN: "123:test-token",
          OWNER_ID: "7",
          WEBHOOK_SECRET: "test-webhook-secret",
          PUBLISH_DELAY_SECONDS: "0",
          SCAN_DELAY_SECONDS: "0",
        },
      },
    }),
  ],
  test: { include: ["cloudflare/test/**/*.test.js"] },
});
