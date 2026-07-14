import type { BackendConfig } from "../../config.js";
import type { PublishResult } from "../../publishing/errors.js";
import { requestJson } from "./http.js";
import { payloadMedia, payloadText } from "./payload.js";

type TelegramResponse = {
  ok?: boolean;
  result?: unknown;
  description?: string;
};

export async function publishToTelegram(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  const token = config.controllerBotToken;
  if (!token) return { skipped: true, reason: "missing Telegram bot token" };
  const chatId = String(payload.chat_id ?? payload.chatId ?? payload.channel ?? `@${config.CHANNEL_USERNAME.replace(/^@/, "")}`);
  const text = payloadText(payload);
  const media = payloadMedia(payload);
  const entities = Array.isArray(payload.entities) ? payload.entities : undefined;

  if (media.length > 1) {
    const items = media.slice(0, 10).map((item, index) => ({
      type: item.type === "VIDEO" ? "video" : "photo",
      media: item.fileId || item.vpsUrl || item.localPath,
      caption: index === 0 ? text.slice(0, 1024) : undefined,
      caption_entities: index === 0 ? entities : undefined,
    }));
    const result = await telegramCall<TelegramResponse>(config, token, "sendMediaGroup", { chat_id: chatId, media: items }, fetchImpl);
    return reactToPublishedMessage(normalizeTelegramResult(result, chatId), config, token, chatId, fetchImpl);
  }

  const item = media[0];
  if (item) {
    const method = item.type === "VIDEO" ? "sendVideo" : "sendPhoto";
    const mediaKey = item.type === "VIDEO" ? "video" : "photo";
    const result = await telegramCall<TelegramResponse>(
      config,
      token,
      method,
      {
        chat_id: chatId,
        [mediaKey]: item.fileId || item.vpsUrl || item.localPath,
        caption: text.slice(0, 1024),
        caption_entities: entities,
      },
      fetchImpl,
    );
    return reactToPublishedMessage(normalizeTelegramResult(result, chatId), config, token, chatId, fetchImpl);
  }

  const result = await telegramCall<TelegramResponse>(
    config,
    token,
    "sendMessage",
    { chat_id: chatId, text, entities, disable_web_page_preview: false },
    fetchImpl,
  );
  return reactToPublishedMessage(normalizeTelegramResult(result, chatId), config, token, chatId, fetchImpl);
}

async function telegramCall<T>(
  config: BackendConfig,
  token: string,
  method: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  return requestJson<T>(fetchImpl, `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function normalizeTelegramResult(result: TelegramResponse, chatId: string): PublishResult {
  if (!result.ok) return { ok: false, error: result.description ?? "telegram_api_failed" };
  const records = Array.isArray(result.result) ? result.result : [result.result];
  const ids = records
    .map((record) => (record && typeof record === "object" ? (record as Record<string, unknown>).message_id : null))
    .filter((id): id is string | number => typeof id === "string" || typeof id === "number");
  const channel = chatId.startsWith("@") ? chatId.slice(1) : null;
  return { ok: true, id: ids[0] ?? null, ids, url: channel && ids[0] ? `https://t.me/${channel}/${ids[0]}` : null, raw: result };
}

async function reactToPublishedMessage(
  result: PublishResult,
  config: BackendConfig,
  token: string,
  chatId: string,
  fetchImpl: typeof fetch,
): Promise<PublishResult> {
  if (!result.ok || result.id == null) return result;
  try {
    await telegramCall<TelegramResponse>(
      config,
      token,
      "setMessageReaction",
      {
        chat_id: chatId,
        message_id: result.id,
        reaction: [{ type: "emoji", emoji: "❤" }],
        is_big: false,
      },
      fetchImpl,
    );
  } catch {
    // Reaction permission is optional and must not retry an already published post.
  }
  return result;
}
