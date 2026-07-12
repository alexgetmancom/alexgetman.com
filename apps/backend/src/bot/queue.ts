import { eq } from "drizzle-orm";
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

export async function showQueue(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
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
      .filter(Boolean)
      .map((t) => new Date(t!));
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
  keyboard.text("← Back to Menu", "cancel_dialog").row();

  const text = items.length === 0 ? "📋 Queue is empty. No scheduled posts or videos." : `📋 *Scheduled Queue (${items.length} items):*`;

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

function formatQueueTime(date: Date): string {
  // Moscow is UTC + 3
  const mskTime = new Date(date.getTime() + 3 * 3600 * 1000);
  const day = String(mskTime.getUTCDate()).padStart(2, "0");
  const month = String(mskTime.getUTCMonth() + 1).padStart(2, "0");
  const hours = String(mskTime.getUTCHours()).padStart(2, "0");
  const minutes = String(mskTime.getUTCMinutes()).padStart(2, "0");
  return `${day}.${month} ${hours}:${minutes}`;
}
