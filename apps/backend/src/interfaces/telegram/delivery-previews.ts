import { type Context, InlineKeyboard, InputFile } from "grammy";
import { type BotLocale, botLocale } from "../../bot/i18n.js";
import { appendTextLinkUrls } from "../../content/text.js";
import type { BackendDb } from "../../db/client.js";
import { splitText } from "../../delivery/social/payload.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { DeliveryProjection } from "../../studio/projections.js";
import { studioServices } from "../../studio/services/index.js";
import { t } from "./i18n/index.js";
import { escapeMarkdown } from "./markdown.js";

const TELEGRAM_MEDIA_GROUP_LIMIT = 10;

/** Telegram renderer for Studio delivery projections. It owns no planning decisions. */
export async function sendTelegramDeliveryPreviews(
  ctx: Context,
  projections: DeliveryProjection[],
  locale: BotLocale = "en",
): Promise<void> {
  for (const projection of projections) {
    await ctx.reply(...deliveryHeader(projection, locale));
    const hasVideo =
      projection.targets.length > 0 && projection.media.some((item) => String(item.type ?? "photo").toLowerCase() === "video");
    if (projection.targets.length) await sendProjectionContent(ctx, projection, !hasVideo);
    if (hasVideo)
      await ctx.reply(t(locale, "preview.video-ready"), {
        reply_markup: new InlineKeyboard().text(t(locale, "preview.show-video"), `delivery_preview_video:${projection.id}`),
      });
    if (projection.notes.length) await ctx.reply(`ℹ️ ${projection.notes.map(escapeMarkdown).join("\n• ")}`, { parse_mode: "Markdown" });
  }
}

/** Reuses the same safe Telegram media rendering for a published archive item. */
export async function sendTelegramArchiveMedia(ctx: Context, media: Record<string, unknown>[]): Promise<void> {
  await sendProjectionContent(
    ctx,
    { id: "archive", label: "Archive", targets: [], text: "", entities: [], media, unavailableTargets: [], notes: [] },
    true,
  );
}

async function sendProjectionContent(ctx: Context, projection: DeliveryProjection, includeVideo = true): Promise<void> {
  const metadata = projection.metadata ? formatMetadata(projection.metadata) : "";
  const text = [projection.text, metadata].filter(Boolean).join("\n\n");
  // Metadata is preview-only and has no source entities; retain formatting only
  // when the projection contains its original post text unchanged.
  const entities = metadata ? [] : projection.entities;
  const mediaItems = includeVideo
    ? projection.media
    : projection.media.filter((item) => String(item.type ?? "photo").toLowerCase() !== "video");
  const first = mediaItems[0];
  if (!first) {
    if (text) await ctx.reply(text, entityOptions(entities));
    return;
  }
  const source = mediaSource(first);
  if (!source) {
    if (text) await ctx.reply(text, entityOptions(entities));
    return;
  }
  const type = String(first.type ?? "photo").toLowerCase();
  const hasCaption = Boolean(text && text.length <= 1024);
  const caption = hasCaption ? { caption: text, ...captionEntityOptions(entities, text.length) } : {};
  if (mediaItems.length > 1) {
    const group = mediaItems.flatMap((item, index) => {
      const media = mediaSource(item);
      if (!media) return [];
      return [
        {
          type: String(item.type ?? "photo").toLowerCase() === "video" ? "video" : "photo",
          media,
          ...(index === 0 ? caption : {}),
        },
      ];
    });
    if (group.length > 1) {
      // Telegram rejects an album larger than 10 outright, which would lose the
      // whole preview; send the first ten as the album and the rest one by one.
      await ctx.replyWithMediaGroup(group.slice(0, TELEGRAM_MEDIA_GROUP_LIMIT) as never);
      for (const item of group.slice(TELEGRAM_MEDIA_GROUP_LIMIT)) {
        if (item.type === "video") await ctx.replyWithVideo(item.media);
        else await ctx.replyWithPhoto(item.media);
      }
      if (text && !hasCaption) await ctx.reply(text, entityOptions(entities));
      return;
    }
  }
  if (type === "video") await ctx.replyWithVideo(source, caption);
  else await ctx.replyWithPhoto(source, caption);
  if (text && !hasCaption) await ctx.reply(text, entityOptions(entities));
  for (const item of mediaItems.slice(1)) {
    const next = mediaSource(item);
    if (!next) continue;
    if (String(item.type ?? "photo").toLowerCase() === "video") await ctx.replyWithVideo(next);
    else await ctx.replyWithPhoto(next);
  }
}

/** Callback-only Telegram adapter for deferred heavy video previews. */
export async function handleTelegramDeliveryPreviewCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  const prefix = "delivery_preview_video:";
  const threadsPrefix = "delivery_preview_threads:";
  const telegramPrefix = "delivery_preview_telegram:";
  if (!data.startsWith(prefix) && !data.startsWith(threadsPrefix) && !data.startsWith(telegramPrefix)) return false;
  const projectionId = data.startsWith(prefix)
    ? data.slice(prefix.length)
    : data.startsWith(threadsPrefix)
      ? data.slice(threadsPrefix.length)
      : data.slice(telegramPrefix.length);
  const actorId = Number(ctx.from?.id);
  const [kind, idText] = projectionId.split(":");
  const id = Number(idText);
  if (!Number.isSafeInteger(id)) return false;
  const delivery =
    kind === "video"
      ? studioServices(backendDb, config).videos.preview(actorId, id).delivery
      : kind === "post"
        ? studioServices(backendDb, config).posts.preview(actorId, id).delivery
        : null;
  const projection = delivery?.projections.find((item) => item.id === projectionId);
  await ctx.answerCallbackQuery();
  if (!projection) return true;
  const locale = botLocale(backendDb, actorId);
  if (data.startsWith(threadsPrefix)) {
    const target = projection.targets.find((item) => item === "threads_ru" || item === "threads_en");
    if (!target) return true;
    await ctx.editMessageText(threadsPreviewText(target, projection.text, projection.entities), {
      reply_markup: new InlineKeyboard().text(t(locale, "preview.show-telegram"), `${telegramPrefix}${projection.id}`),
    });
    return true;
  }
  if (data.startsWith(telegramPrefix)) {
    await ctx.editMessageText(...deliveryHeader(projection, locale));
    return true;
  }
  await sendProjectionContent(
    ctx,
    {
      id: projection.id,
      label: projection.label,
      targets: projection.targets,
      text: "",
      entities: [],
      media: projection.media,
      unavailableTargets: [],
      notes: projection.notes,
    },
    true,
  );
  return true;
}

function deliveryHeader(
  projection: DeliveryProjection,
  locale: BotLocale,
): [string, { parse_mode: "Markdown"; reply_markup?: InlineKeyboard }] {
  const targets = projection.targets.join(" · ") || "No compatible delivery target";
  const threadsTarget = projection.targets.find((item) => item === "threads_ru" || item === "threads_en");
  const reply_markup = threadsTarget
    ? new InlineKeyboard().text(t(locale, "preview.show-threads"), `delivery_preview_threads:${projection.id}`)
    : undefined;
  return [
    `👁 *${escapeMarkdown(projection.label)}*\n${escapeMarkdown(targets)}`,
    { parse_mode: "Markdown", ...(reply_markup ? { reply_markup } : {}) },
  ];
}

export function threadsPreviewText(target: "threads_ru" | "threads_en", text: string, entities: Record<string, unknown>[] = []): string {
  const parts = splitText(appendTextLinkUrls(text, entities), 480);
  const label = target === "threads_ru" ? "Threads RU" : "Threads EN";
  return `🧵 ${label} · ${parts.length}\n\n${parts.map((part, index) => `${threadMarker(index)} ${part}`).join("\n\n")}`;
}

function threadMarker(index: number): string {
  return ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"][index] ?? `${index + 1}.`;
}

function entityOptions(entities: Record<string, unknown>[]) {
  return entities.length ? { entities: entities as never } : {};
}

function captionEntityOptions(entities: Record<string, unknown>[], length: number) {
  const safeEntities = entities.flatMap((entity) => {
    const offset = Number(entity.offset);
    const entityLength = Number(entity.length);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(entityLength) || offset < 0 || entityLength <= 0 || offset >= length)
      return [];
    return [{ ...entity, offset, length: Math.min(entityLength, length - offset) }];
  });
  return safeEntities.length ? { caption_entities: safeEntities as never } : {};
}

function mediaSource(media: Record<string, unknown>): InputFile | string | null {
  const path = typeof media.local_path === "string" ? media.local_path : typeof media.localPath === "string" ? media.localPath : null;
  if (path) return new InputFile(path);
  if (typeof media.file_id === "string") return media.file_id;
  if (typeof media.fileId === "string") return media.fileId;
  return null;
}

function formatMetadata(metadata: Record<string, unknown>): string {
  const lines: string[] = [];
  if (metadata.title) lines.push(`Title: ${String(metadata.title)}`);
  if (metadata.description) lines.push(`Description: ${String(metadata.description)}`);
  if (metadata.caption) lines.push(`Caption: ${String(metadata.caption)}`);
  if (Array.isArray(metadata.tags) && metadata.tags.length) lines.push(`Tags: ${metadata.tags.join(", ")}`);
  if (metadata.gameUrl) lines.push(`Game: ${String(metadata.gameUrl)}`);
  return lines.join("\n");
}
