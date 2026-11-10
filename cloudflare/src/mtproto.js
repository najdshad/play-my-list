import { TelegramError } from "./telegram.js";

export const mtprotoConfigured = (env) =>
  !!(env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH && env.TELEGRAM_SESSION);

// A user session can delete posts of any age; the Bot API stops at 48 hours.
export async function deleteMessages(env, chatId, messageIds) {
  const { TelegramClient, Api } = await import("teleproto");
  const { StringSession } = await import("teleproto/sessions");
  let client;
  try {
    client = new TelegramClient(
      new StringSession(env.TELEGRAM_SESSION),
      Number(env.TELEGRAM_API_ID),
      env.TELEGRAM_API_HASH,
      {
        connectionRetries: 2,
        reconnectRetries: 0,
        requestRetries: 2,
        autoReconnect: false,
        catchUp: false,
        timeout: 20,
        deviceModel: "Play My List",
        systemVersion: "Worker",
        appVersion: "1.0",
      },
    );
    await client.connect();
    const dialog = await findDialog(client, chatId);
    if (dialog.isChannel)
      await client.invoke(
        new Api.channels.DeleteMessages({
          channel: dialog.inputEntity,
          id: messageIds,
        }),
      );
    else
      await client.invoke(
        new Api.messages.DeleteMessages({ revoke: true, id: messageIds }),
      );
  } catch (error) {
    throw new TelegramError(
      error?.errorMessage ||
        error?.message ||
        "The Telegram account session could not delete these posts.",
      409,
    );
  } finally {
    await client?.destroy().catch(() => {});
  }
}

// Playlist channels are admin channels the account already has in its dialogs,
// so the dialog list supplies the access hash that channels.deleteMessages needs.
async function findDialog(client, chatId) {
  for (const archived of [false, true])
    for await (const dialog of client.iterDialogs({ archived }))
      if (String(dialog.id) === String(chatId)) return dialog;
  throw new Error(
    `Channel ${chatId} is not in the account's chat list. Join the channel with the account first.`,
  );
}
