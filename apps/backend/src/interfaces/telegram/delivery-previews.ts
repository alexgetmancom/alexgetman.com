import { type Context, InlineKeyboard, InputFile } from "grammy";
import type { BotLocale } from "../../bot/i18n.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { DeliveryProjection } from "../../studio/projections.js";
import { studioServices } from "../../studio/services/index.js";
import { t } from "./i18n/index.js";

/** Telegram renderer for Studio delivery projections. It owns no planning decisions. */
export async function sendTelegramDeliveryPreviews(
  ctx: Context,
  projections: DeliveryProjection[],
  locale: BotLocale = "en",
): Promise<void> {
  for (const projection of projections) {
    const targets = projection.targets.join(" · ");
    await ctx.reply(`👁 *${escapeMarkdown(projection.label)}*\n${escapeMarkdown(targets)}`, { parse_mode: "Markdown" });
    const hasVideo = projection.media.some((item) => String(item.type ?? "photo").toLowerCase() === "video");
    await sendProjectionContent(ctx, projection, !hasVideo);
    if (hasVideo)
      await ctx.reply(t(locale, "preview.video-ready"), {
        reply_markup: new InlineKeyboard().text(t(locale, "preview.show-video"), `delivery_preview_video:${projection.id}`),
      });
    if (projection.notes.length) await ctx.reply(`ℹ️ ${projection.notes.map(escapeMarkdown).join("\n• ")}`, { parse_mode: "Markdown" });
  }
}

/** Reuses the same safe Telegram media rendering for a published archive item. */
export async function sendTelegramArchiveMedia(ctx: Context, media: Record<string, unknown>[]): Promise<void> {
  await sendProjectionContent(ctx, { id: "archive", label: "Archive", targets: [], text: "", media, notes: [] }, true);
}

async function sendProjectionContent(ctx: Context, projection: DeliveryProjection, includeVideo = true): Promise<void> {
  const metadata = projection.metadata ? formatMetadata(projection.metadata) : "";
  const text = [projection.text, metadata].filter(Boolean).join("\n\n");
  const mediaItems = includeVideo
    ? projection.media
    : projection.media.filter((item) => String(item.type ?? "photo").toLowerCase() !== "video");
  const first = mediaItems[0];
  if (!first) {
    if (text) await ctx.reply(text);
    return;
  }
  const source = mediaSource(first);
  if (!source) {
    if (text) await ctx.reply(text);
    return;
  }
  const type = String(first.type ?? "photo").toLowerCase();
  const caption = text && text.length <= 1024 ? { caption: text } : {};
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
      await ctx.replyWithMediaGroup(group as never);
      if (text && !caption.caption) await ctx.reply(text);
      return;
    }
  }
  if (type === "video") await ctx.replyWithVideo(source, caption);
  else await ctx.replyWithPhoto(source, caption);
  if (text && !caption.caption) await ctx.reply(text);
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
  if (!data.startsWith(prefix)) return false;
  const projectionId = data.slice(prefix.length);
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
  await sendProjectionContent(
    ctx,
    {
      id: projection.id,
      label: projection.label,
      targets: projection.targets,
      text: "",
      media: projection.media,
      notes: projection.notes,
    },
    true,
  );
  return true;
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

function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]`])/g, "\\$1");
}
