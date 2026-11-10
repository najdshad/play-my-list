// Run with: npm run telegram:session
// Reads TELEGRAM_API_ID and TELEGRAM_API_HASH from .dev.vars. The printed
// session string grants full access to the account, so keep it secret.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
if (!apiId || !apiHash)
  throw new Error(
    "Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .dev.vars first.",
  );

const input = createInterface({ input: stdin, output: stdout });
const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 3,
});
try {
  await client.start({
    phoneNumber: () =>
      input.question("Phone number with country code (+...): "),
    phoneCode: () => input.question("Login code: "),
    password: () => input.question("Two-step password (if set): "),
    onError: (error) => {
      console.error(error.message);
      return true;
    },
  });
  console.log(
    `\nTELEGRAM_SESSION="${client.session.save()}"\n\n` +
      "Add this line to .dev.vars and upload the secrets with:\n" +
      "  npx wrangler secret bulk .dev.vars\n" +
      "Never commit or share the session string.",
  );
} finally {
  await client.disconnect();
  input.close();
}
