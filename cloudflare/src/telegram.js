export class TelegramError extends Error {
  constructor(description, code = 0, retryAfter = null) {
    super(description);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export async function telegram(token, method, parameters) {
  let response, payload;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parameters),
      signal: controller.signal,
    });
    payload = await response.json();
  } catch {
    throw new TelegramError("Telegram connection failed or timed out.");
  } finally {
    clearTimeout(timeout);
  }
  if (!payload.ok)
    throw new TelegramError(
      payload.description || "Telegram rejected the request.",
      payload.error_code || response.status,
      payload.parameters?.retry_after ?? null,
    );
  return payload.result;
}

export function matches(error, ...messages) {
  return (
    error instanceof TelegramError &&
    error.code === 400 &&
    messages.some((text) => error.message.toLowerCase().includes(text))
  );
}
export const scanGap = (error) =>
  matches(
    error,
    "message to forward not found",
    "message_id_invalid",
    "message can't be forwarded",
  );
export const scanSourceMissing = (error) =>
  matches(error, "message to forward not found", "message_id_invalid");
export const sourceUnavailable = (error) =>
  matches(
    error,
    "message to copy not found",
    "message_id_invalid",
    "message can't be copied",
  );
export const invalidAudio = (error) =>
  matches(
    error,
    "wrong file identifier",
    "wrong remote file identifier",
    "file_id_invalid",
    "file_reference_expired",
    "file reference expired",
  );
export const transient = (error) =>
  error instanceof TelegramError && (error.code === 0 || error.code >= 500);
