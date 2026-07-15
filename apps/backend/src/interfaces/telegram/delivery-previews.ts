import { type Context, InputFile } from "grammy";
import type { DeliveryProjection } from "../../studio/projections.js";

/** Telegram renderer for Studio delivery projections. It owns no planning decisions. */
export async function sendTelegramDeliveryPreviews(ctx: Context, projections: DeliveryProjection[]): Promise<void> {
  for (const projection of projections) {
    const targets = projection.targets.join(" · ");
    await ctx.reply(`👁 *${escapeMarkdown(projection.label)}*\n${escapeMarkdown(targets)}`, { parse_mode: "Markdown" });
    await sendProjectionContent(ctx, projection);
    if (projection.notes.length) await ctx.reply(`ℹ️ ${projection.notes.map(escapeMarkdown).join("\n• ")}`, { parse_mode: "Markdown" });
  }
}

async function sendProjectionContent(ctx: Context, projection: DeliveryProjection): Promise<void> {
  const metadata = projection.metadata ? formatMetadata(projection.metadata) : "";
  const text = [projection.text, metadata].filter(Boolean).join("\n\n");
  const first = projection.media[0];
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
  if (projection.media.length > 1) {
    const group = projection.media.flatMap((item, index) => {
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
  for (const item of projection.media.slice(1)) {
    const next = mediaSource(item);
    if (!next) continue;
    if (String(item.type ?? "photo").toLowerCase() === "video") await ctx.replyWithVideo(next);
    else await ctx.replyWithPhoto(next);
  }
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
