import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../../foundation/config.js";
import { requestJson } from "../../foundation/http.js";
import type { PublishResult } from "../../publishing/errors.js";
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
  const entities = Array.isArray(payload.entities) ? payload.entities : [];

  const attachments: TelegramAttachment[] = [];
  const blocks: Record<string, unknown>[] = [];
  if (media.length > 0) {
    const mediaBlocks = media.slice(0, 50).map((item, index) => {
      const kind = item.type === "VIDEO" ? "video" : "photo";
      const source = telegramMediaSource(item.fileId, item.vpsUrl, item.localPath, `media-${index}`, attachments);
      return { type: kind, [kind]: { type: kind, media: source } };
    });
    blocks.push({ type: "slideshow", blocks: mediaBlocks });
  }
  if (text) blocks.push({ type: "paragraph", text: richTextFromEntities(text, entities) });

  const richMessage = { blocks };
  const request = attachments.length
    ? await telegramForm({ chat_id: chatId, rich_message: JSON.stringify(richMessage) }, attachments)
    : { chat_id: chatId, rich_message: richMessage };
  const result = await telegramCall<TelegramResponse>(config, token, "sendRichMessage", request, fetchImpl);
  return reactToPublishedMessage(normalizeTelegramResult(result, chatId), config, token, chatId, fetchImpl);
}

type RichText = string | RichTextNode | (string | RichTextNode)[];
type RichTextKind = "bold" | "italic" | "underline" | "strikethrough" | "spoiler" | "code";
type RichTextNode = { type: RichTextKind; text: RichText };
type EntitySpan = { offset: number; length: number; kind: RichTextKind };

const wrappableEntityTypes: Record<string, RichTextKind> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strikethrough: "strikethrough",
  spoiler: "spoiler",
  code: "code",
};

/** Converts Telegram MessageEntity offsets (UTF-16 code units, same as JS string indices)
 * into the nested RichText shape sendRichMessage expects. Links are deliberately dropped —
 * posts don't carry outbound hyperlinks — and entities Telegram already auto-detects from
 * plain text (url, mention, hashtag, bot_command, ...) are left as-is. */
function richTextFromEntities(text: string, entities: unknown[]): RichText {
  const length = text.length;
  const safeEntities: EntitySpan[] = entities.flatMap((entity): EntitySpan[] => {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) return [];
    const value = entity as Record<string, unknown>;
    const offset = Number(value.offset);
    const entityLength = Number(value.length);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(entityLength) || offset < 0 || entityLength <= 0 || offset >= length)
      return [];
    const kind = wrappableEntityTypes[typeof value.type === "string" ? value.type : ""];
    if (!kind) return [];
    return [{ offset, length: Math.min(entityLength, length - offset), kind }];
  });
  if (!safeEntities.length) return text;

  const boundaries = new Set([0, length]);
  for (const entity of safeEntities) {
    boundaries.add(entity.offset);
    boundaries.add(entity.offset + entity.length);
  }
  const cuts = [...boundaries].sort((a, b) => a - b);

  const segments: (string | RichTextNode)[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i] as number;
    const end = cuts[i + 1] as number;
    const covering = safeEntities
      .filter((entity) => entity.offset <= start && entity.offset + entity.length >= end)
      .sort((a, b) => a.length - b.length);
    let node: string | RichTextNode = text.slice(start, end);
    for (const entity of covering) node = { type: entity.kind, text: node };
    segments.push(node);
  }
  return segments.length === 1 && typeof segments[0] === "string" ? (segments[0] as string) : segments;
}

async function telegramCall<T>(
  config: BackendConfig,
  token: string,
  method: string,
  payload: Record<string, unknown> | FormData,
  fetchImpl: typeof fetch,
): Promise<T> {
  const form = payload instanceof FormData;
  return requestJson<T>(fetchImpl, `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/bot${token}/${method}`, {
    method: "POST",
    ...(form ? {} : { headers: { "Content-Type": "application/json" } }),
    body: form ? payload : JSON.stringify(payload),
  });
}

type TelegramAttachment = { name: string; localPath: string };

function telegramMediaSource(
  fileId: string | undefined,
  vpsUrl: string | undefined,
  localPath: string | undefined,
  attachmentName: string,
  attachments: TelegramAttachment[],
): string | undefined {
  if (fileId || vpsUrl) return fileId || vpsUrl;
  if (!localPath) return undefined;
  attachments.push({ name: attachmentName, localPath });
  return `attach://${attachmentName}`;
}

async function telegramForm(fields: Record<string, string>, attachments: TelegramAttachment[]): Promise<FormData> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  for (const attachment of attachments) {
    const bytes = await fs.promises.readFile(attachment.localPath);
    form.set(attachment.name, new Blob([bytes]), path.basename(attachment.localPath));
  }
  return form;
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
