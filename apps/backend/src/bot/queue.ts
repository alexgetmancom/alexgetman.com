import { eq, inArray } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { drafts, videoDrafts, videoTargets } from "../db/schema.js";

type QueueItem = {
  id: number;
  name: string;
  time: Date;
  type: "POST" | "YT" | "IG" | "ВСЕ";
  callback: string;
};

type QueueView = "home" | "upcoming" | "drafts" | "attention";

export async function showQueue(ctx: Context, backendDb: BackendDb, _config: BackendConfig, view: QueueView = "home"): Promise<void> {
  if (view === "home") return showQueueHome(ctx, backendDb);
  if (view === "drafts") return showDrafts(ctx, backendDb);
  if (view === "attention") return showAttention(ctx, backendDb);
  const postDrafts = backendDb.db.select().from(drafts).where(eq(drafts.status, "scheduled")).all();
  const vDrafts = backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.status, "scheduled")).all();

  const items: QueueItem[] = [];

  for (const draft of postDrafts) {
    const timeStr = draft.scheduledAt ?? draft.scheduledEnAt;
    if (!timeStr) continue;

    // Extract first line and slice to 10 chars
    const rawLabel = draft.textRu.split("\n")[0]?.trim() || `Post #${draft.id}`;
    const name = rawLabel.slice(0, 10).trim() || `Post #${draft.id}`;

    items.push({
      id: draft.id,
      name,
      time: new Date(timeStr),
      type: "POST",
      callback: `preview:${draft.id}`,
    });
  }

  for (const vd of vDrafts) {
    const targets = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, vd.id)).all();
    const activeTargets = targets.filter((t) => t.status === "scheduled");
    if (activeTargets.length === 0) continue;

    const times = activeTargets
      .map((t) => t.scheduledAt)
      .filter((scheduledAt): scheduledAt is string => Boolean(scheduledAt))
      .map((scheduledAt) => new Date(scheduledAt));
    if (times.length === 0) continue;
    const earliestTime = new Date(Math.min(...times.map((t) => t.getTime())));

    const hasYt = activeTargets.some((t) => t.target === "youtube_shorts");
    const hasIg = activeTargets.some((t) => t.target === "instagram_reels");
    let type: "YT" | "IG" | "ВСЕ" = "YT";
    if (hasYt && hasIg) type = "ВСЕ";
    else if (hasIg) type = "IG";

    const name = vd.label.trim().slice(0, 10).trim() || `Video #${vd.id}`;

    items.push({
      id: vd.id,
      name,
      time: earliestTime,
      type,
      callback: `video_open:${vd.id}`,
    });
  }

  // Sort chronologically
  items.sort((a, b) => a.time.getTime() - b.time.getTime());

  const keyboard = new InlineKeyboard();
  for (const item of items) {
    const timeStr = formatQueueTime(item.time);
    keyboard.text(`${item.name} ${timeStr} - ${item.type}`, item.callback).row();
  }
  keyboard.text("← Back", "queue_home").row().text("← Menu", "cancel_dialog");

  const text = items.length === 0 ? "📋 No upcoming publications." : `📋 *Upcoming publications (${items.length}):*`;

  const messageId = ctx.callbackQuery?.message?.message_id;
  if (messageId && ctx.chat?.id) {
    await ctx.api.editMessageText(ctx.chat.id, messageId, text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } else {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  }
}

async function showQueueHome(ctx: Context, backendDb: BackendDb): Promise<void> {
  const textDrafts = backendDb.db.select({ id: drafts.id }).from(drafts).where(eq(drafts.status, "needs_review")).all().length;
  const videoDraftCount = backendDb.db
    .select({ id: videoDrafts.id })
    .from(videoDrafts)
    .where(inArray(videoDrafts.status, ["draft", "editing"]))
    .all().length;
  const failedPosts = backendDb.db.select({ id: drafts.id }).from(drafts).where(eq(drafts.status, "failed")).all().length;
  const failedVideos = backendDb.db.select({ id: videoDrafts.id }).from(videoDrafts).where(eq(videoDrafts.status, "partial")).all().length;
  const keyboard = new InlineKeyboard()
    .text("🕒 Upcoming", "queue_upcoming")
    .text(`🟡 Drafts (${textDrafts + videoDraftCount})`, "queue_drafts")
    .row()
    .text(`🔴 Needs attention (${failedPosts + failedVideos})`, "queue_attention")
    .row()
    .text("← Menu", "cancel_dialog");
  await replaceQueueMessage(ctx, "📋 *Work queue*\n\nChoose what to review:", keyboard);
}

async function showDrafts(ctx: Context, backendDb: BackendDb): Promise<void> {
  const textDrafts = backendDb.db.select().from(drafts).where(eq(drafts.status, "needs_review")).all();
  const videos = backendDb.db
    .select()
    .from(videoDrafts)
    .where(inArray(videoDrafts.status, ["draft", "editing"]))
    .all();
  const keyboard = new InlineKeyboard();
  for (const draft of textDrafts)
    keyboard.text(`📝 #${draft.id} ${(draft.textRu.split("\n")[0] || "Post").slice(0, 28)}`, `preview:${draft.id}`).row();
  for (const video of videos) keyboard.text(`🎬 #${video.id} ${(video.label || "Video").slice(0, 28)}`, `video_open:${video.id}`).row();
  keyboard.text("← Work queue", "queue_home");
  await replaceQueueMessage(ctx, textDrafts.length + videos.length ? "🟡 *Drafts*" : "🟡 No drafts.", keyboard);
}

async function showAttention(ctx: Context, backendDb: BackendDb): Promise<void> {
  const textPosts = backendDb.db.select().from(drafts).where(eq(drafts.status, "failed")).all();
  const videos = backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.status, "partial")).all();
  const keyboard = new InlineKeyboard();
  for (const draft of textPosts) keyboard.text(`❌ Post #${draft.id}`, `progress_details:${draft.id}`).row();
  for (const video of videos)
    keyboard.text(`❌ Video #${video.id} ${(video.label || "Video").slice(0, 22)}`, `video_open:${video.id}`).row();
  keyboard.text("← Work queue", "queue_home");
  await replaceQueueMessage(ctx, textPosts.length + videos.length ? "🔴 *Needs attention*" : "✅ Nothing needs attention.", keyboard);
}

async function replaceQueueMessage(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (messageId && ctx.chat?.id)
    await ctx.api.editMessageText(ctx.chat.id, messageId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  else await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

function formatQueueTime(date: Date): string {
  // Moscow is UTC + 3
  const mskTime = new Date(date.getTime() + 3 * 3600 * 1000);
  const day = String(mskTime.getUTCDate()).padStart(2, "0");
  const month = String(mskTime.getUTCMonth() + 1).padStart(2, "0");
  const hours = String(mskTime.getUTCHours()).padStart(2, "0");
  const minutes = String(mskTime.getUTCMinutes()).padStart(2, "0");
  return `${day}.${month} ${hours}:${minutes}`;
}
