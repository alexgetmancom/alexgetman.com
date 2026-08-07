import { type Context, InlineKeyboard, InputFile } from "grammy";
import { botLocale } from "../../bot/i18n.js";
import type { BackendDb } from "../../db/client.js";
import { splitText } from "../../delivery/social/payload.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { log } from "../../foundation/logger.js";
import { escapeMarkdown } from "../../foundation/markdown.js";
import { threadsBody, threadsTextLimit } from "../../publishing/threads-text.js";
import type { DeliveryProjection } from "../../studio/projections.js";
import { createStudioServices } from "../../studio/services/index.js";

const TELEGRAM_MEDIA_GROUP_LIMIT = 10;

/** Telegram renderer for Studio delivery projections. It owns no planning decisions. */
export async function sendTelegramDeliveryPreviews(
  ctx: Context,
  projections: DeliveryProjection[],
  locale: StudioLocale = "en",
): Promise<void> {
  for (const projection of projections) {
    // One unrenderable projection — a missing file, a Telegram 400 — must not
    // swallow the previews that follow it.
    try {
      await ctx.reply(...deliveryHeader(projection, locale));
      const hasVideo = projection.targets.length > 0 && projection.media.some(isVideo);
      if (projection.targets.length) await sendProjectionContent(ctx, projection, !hasVideo, locale);
      if (hasVideo)
        await ctx.reply(t(locale, "preview.video-ready"), {
          reply_markup: new InlineKeyboard().text(t(locale, "preview.show-video"), `delivery_preview_video:${projection.id}`),
        });
      if (projection.notes.length)
        await ctx.reply(projection.notes.map((note) => `ℹ️ ${escapeMarkdown(note)}`).join("\n"), { parse_mode: "Markdown" });
    } catch (error) {
      log("error", "telegram delivery preview failed", { projection: projection.id, error });
    }
  }
}

/** Reuses the same safe Telegram media rendering for a published archive item. */
export async function sendTelegramArchiveMedia(ctx: Context, media: Record<string, unknown>[]): Promise<void> {
  await sendMedia(ctx, media, "", []);
}

async function sendProjectionContent(
  ctx: Context,
  projection: DeliveryProjection,
  includeVideo = true,
  locale: StudioLocale = "en",
): Promise<void> {
  const metadata = projection.metadata ? formatMetadata(projection.metadata, locale) : "";
  const text = [projection.text, metadata].filter(Boolean).join("\n\n");
  // Metadata is preview-only and has no source entities; retain formatting only
  // when the projection contains its original post text unchanged.
  const entities = metadata ? [] : projection.entities;
  const media = includeVideo ? projection.media : projection.media.filter((item) => !isVideo(item));
  await sendMedia(ctx, media, text, entities);
}

type RenderableMedia = { source: InputFile | string; video: boolean };

/** Sends whatever of `media` Telegram can actually address, with `text` attached once. */
async function sendMedia(ctx: Context, media: Record<string, unknown>[], text: string, entities: Record<string, unknown>[]) {
  // An item with neither a local path nor a file id cannot be sent; dropping it
  // here keeps the rest of the album from riding on the first item's fate.
  const items = media.flatMap<RenderableMedia>((item) => {
    const source = mediaSource(item);
    return source ? [{ source, video: isVideo(item) }] : [];
  });
  const first = items[0];
  if (!first) {
    if (text) await ctx.reply(text, entityOptions(entities, text.length));
    return;
  }
  const hasCaption = Boolean(text && text.length <= 1024);
  const caption = hasCaption ? { caption: text, ...captionEntityOptions(entities, text.length) } : {};
  if (items.length > 1) {
    const group = items.map((item, index) => ({
      type: item.video ? "video" : "photo",
      media: item.source,
      ...(index === 0 ? caption : {}),
    }));
    // Telegram rejects an album larger than 10 outright, which would lose the
    // whole preview; send the first ten as the album and the rest one by one.
    await ctx.replyWithMediaGroup(group.slice(0, TELEGRAM_MEDIA_GROUP_LIMIT) as never);
    for (const item of items.slice(TELEGRAM_MEDIA_GROUP_LIMIT)) {
      if (item.video) await ctx.replyWithVideo(item.source);
      else await ctx.replyWithPhoto(item.source);
    }
  } else if (first.video) await ctx.replyWithVideo(first.source, caption);
  else await ctx.replyWithPhoto(first.source, caption);
  if (text && !hasCaption) await ctx.reply(text, entityOptions(entities, text.length));
}

function isVideo(media: Record<string, unknown>): boolean {
  return String(media.type ?? "photo").toLowerCase() === "video";
}

/** Callback-only Telegram adapter for deferred heavy video previews. */
export async function handleTelegramDeliveryPreviewCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  const view = PREVIEW_VIEWS.find((item) => data.startsWith(item.prefix));
  if (!view) return false;
  const projectionId = data.slice(view.prefix.length);
  const actorId = Number(ctx.from?.id);
  const [kind, idText] = projectionId.split(":");
  const id = Number(idText);
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(actorId)) return false;
  const delivery =
    kind === "video"
      ? createStudioServices(backendDb, config).videos.preview(actorId, id).delivery
      : kind === "post"
        ? createStudioServices(backendDb, config).posts.preview(actorId, id).delivery
        : null;
  const projection = delivery?.projections.find((item) => item.id === projectionId);
  await ctx.answerCallbackQuery();
  if (!projection) return true;
  const locale = botLocale(backendDb, actorId);
  if (view.name === "threads") {
    const target = projection.targets.find((item) => item === "threads_ru" || item === "threads_en");
    if (!target) return true;
    await ctx.editMessageText(threadsPreviewText(target, projection.text, projection.entities, Boolean(projection.threadsChain), locale), {
      reply_markup: new InlineKeyboard().text(t(locale, "preview.show-telegram"), `${TELEGRAM_VIEW_PREFIX}${projection.id}`),
    });
    return true;
  }
  if (view.name === "telegram") {
    await ctx.editMessageText(...deliveryHeader(projection, locale));
    return true;
  }
  await sendMedia(ctx, projection.media, "", []);
  return true;
}

const TELEGRAM_VIEW_PREFIX = "delivery_preview_telegram:";

const PREVIEW_VIEWS = [
  { name: "video", prefix: "delivery_preview_video:" },
  { name: "threads", prefix: "delivery_preview_threads:" },
  { name: "telegram", prefix: TELEGRAM_VIEW_PREFIX },
] as const;

function deliveryHeader(
  projection: DeliveryProjection,
  locale: StudioLocale,
): [string, { parse_mode: "Markdown"; reply_markup?: InlineKeyboard }] {
  const targets = projection.targets.join(" · ") || t(locale, "preview.no-compatible-target");
  const threadsTarget = projection.targets.find((item) => item === "threads_ru" || item === "threads_en");
  const reply_markup = threadsTarget
    ? new InlineKeyboard().text(t(locale, "preview.show-threads"), `delivery_preview_threads:${projection.id}`)
    : undefined;
  return [
    `👁 *${escapeMarkdown(projection.label)}*\n${escapeMarkdown(targets)}`,
    { parse_mode: "Markdown", ...(reply_markup ? { reply_markup } : {}) },
  ];
}

export function threadsPreviewText(
  target: "threads_ru" | "threads_en",
  text: string,
  entities: Record<string, unknown>[] = [],
  chain = false,
  locale: StudioLocale = "en",
): string {
  // Threads takes one post, so the preview is a character budget rather than a
  // numbered chain. The numbered form comes back only for a draft whose author
  // waived the rule — there the chain is the thing they need to proofread.
  const limit = threadsTextLimit(target);
  const decision = threadsBody(target, text, entities, { chain });
  const label = target === "threads_ru" ? "Threads RU" : "Threads EN";
  // The link's fate is stated on the counter line, with how many characters it
  // was short. Without that number a dropped link is just something the bot ate.
  const linkNote = decision.droppedUrl
    ? ` · ${t(locale, "preview.threads-link-dropped", { shortfall: decision.shortfall })}`
    : decision.url
      ? ` · ${t(locale, "preview.threads-link-kept")}`
      : "";
  if (!chain) {
    const budget = `${decision.text.length}/${limit}${decision.text.length > limit ? " ⚠️" : ""}`;
    return `🧵 ${label} · ${budget}${linkNote}\n\n${decision.text}`;
  }
  const parts = splitText(decision.text, limit);
  return `🧵 ${label} · ${parts.length}${linkNote}\n\n${parts.map((part, index) => `${threadMarker(index)} ${part}`).join("\n\n")}`;
}

function threadMarker(index: number): string {
  return ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"][index] ?? `${index + 1}.`;
}

function entityOptions(entities: Record<string, unknown>[], length: number) {
  const safe = safeEntities(entities, length);
  return safe.length ? { entities: safe as never } : {};
}

function captionEntityOptions(entities: Record<string, unknown>[], length: number) {
  const safe = safeEntities(entities, length);
  return safe.length ? { caption_entities: safe as never } : {};
}

/** An entity reaching past the text it annotates is a 400 from Telegram, so clamp or drop it. */
function safeEntities(entities: Record<string, unknown>[], length: number) {
  return entities.flatMap((entity) => {
    const offset = Number(entity.offset);
    const entityLength = Number(entity.length);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(entityLength) || offset < 0 || entityLength <= 0 || offset >= length)
      return [];
    return [{ ...entity, offset, length: Math.min(entityLength, length - offset) }];
  });
}

function mediaSource(media: Record<string, unknown>): InputFile | string | null {
  const path = typeof media.local_path === "string" ? media.local_path : typeof media.localPath === "string" ? media.localPath : null;
  if (path) return new InputFile(path);
  if (typeof media.file_id === "string") return media.file_id;
  if (typeof media.fileId === "string") return media.fileId;
  return null;
}

function formatMetadata(metadata: Record<string, unknown>, locale: StudioLocale): string {
  const lines: string[] = [];
  if (metadata.title) lines.push(`${t(locale, "preview.metadata-title")}: ${String(metadata.title)}`);
  if (metadata.description) lines.push(`${t(locale, "preview.metadata-description")}: ${String(metadata.description)}`);
  if (metadata.caption) lines.push(`${t(locale, "preview.metadata-caption")}: ${String(metadata.caption)}`);
  if (Array.isArray(metadata.tags) && metadata.tags.length)
    lines.push(`${t(locale, "preview.metadata-tags")}: ${metadata.tags.join(", ")}`);
  if (metadata.gameUrl) lines.push(`${t(locale, "preview.metadata-game")}: ${String(metadata.gameUrl)}`);
  return lines.join("\n");
}
