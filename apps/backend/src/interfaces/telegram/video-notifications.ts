import { eq } from "drizzle-orm";
import { type Bot, InlineKeyboard } from "grammy";
import { botLocale } from "../../bot/i18n.js";
import type { BackendDb } from "../../db/client.js";
import { drafts, studioNotificationSettings, videoDrafts, videoTargets } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import { getVideoDraft } from "../../publishing/video-data.js";
import type { VideoTarget } from "../../publishing/video-types.js";
import { videoTargetLabel } from "../../publishing/video-types.js";
import { telegramVideoCard } from "./control-cards.js";
import { videoPreview } from "./video-preview.js";
import { formatVideoTime } from "./video-time.js";

/** These adapters render times, so they need the configured zone — nothing more. */
type StudioTimeConfig = Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">;

export async function notifyFinalVideoFailure(
  backendDb: BackendDb,
  bot: Bot | null,
  videoDraftId: number,
  videoTargetId: number | null,
): Promise<void> {
  if (!bot || !videoTargetId) return;
  const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, videoTargetId)).get();
  if (target?.status !== "failed") return;
  const draft = getVideoDraft(backendDb, videoDraftId);
  const targetName = target.target as VideoTarget;
  const locale = botLocale(backendDb, draft.actorId);
  const title = draft.label || t(locale, "common.untitled");
  await bot.api.sendMessage(
    draft.actorId,
    `${t(locale, "notif.video-failed", { label: videoTargetLabel(targetName), title })}\n\n${target.lastError || t(locale, "notif.unknown-error")}`,
    {
      reply_markup: new InlineKeyboard().text(
        t(locale, "notif.retry", { platform: targetName === "youtube_shorts" ? "YouTube" : "Instagram" }),
        `video_retry:${targetName}:${draft.id}`,
      ),
    },
  );
}

export async function refreshVideoControlCard(
  backendDb: BackendDb,
  bot: Bot | null,
  config: StudioTimeConfig,
  videoDraftId: number,
): Promise<void> {
  if (!bot) return;
  const card = telegramVideoCard(backendDb, videoDraftId);
  if (!card || card.chatId == null || card.messageId == null) return;
  const preview = videoPreview(backendDb, config, videoDraftId);
  try {
    await bot.api.editMessageText(card.chatId, card.messageId, preview.text, {
      parse_mode: "Markdown",
      reply_markup: preview.keyboard,
    });
  } catch {
    // A deleted or manually edited Telegram message must not stop publication.
  }
}

export async function sendVideoReminder(
  backendDb: BackendDb,
  bot: Bot | null,
  config: StudioTimeConfig & Pick<BackendConfig, "VIDEO_REMINDER_MINUTES">,
  videoDraftId: number,
  videoTargetId: number | null,
): Promise<void> {
  const reminderMinutes = config.VIDEO_REMINDER_MINUTES;
  const draft = getVideoDraft(backendDb, videoDraftId);
  const target = videoTargetId == null ? null : backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, videoTargetId)).get();
  if (!bot || !target || draft.status !== "scheduled") return;
  const locale = botLocale(backendDb, draft.actorId);
  const title = draft.label || t(locale, "common.untitled");
  const text = `${t(locale, "notif.reminder-head", { minutes: reminderMinutes })}\n\n🎬 ${title}\n• ${videoTargetLabel(target.target as VideoTarget)}\n\n${formatVideoTime(target.scheduledAt, locale, config)}`;
  await bot.api.sendMessage(draft.actorId, text, {
    reply_markup: new InlineKeyboard()
      .text(t(locale, "notif.open"), `video_open:${draft.id}`)
      .text(t(locale, "notif.cancel-btn"), `video_cancel:${draft.id}`),
  });
  backendDb.db
    .update(videoDrafts)
    .set({ reminderSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(videoDrafts.id, draft.id))
    .run();
}

/** Telegram delivery adapter for Studio events. The event and preference live above Telegram. */
export async function sendStudioReminder(
  backendDb: BackendDb,
  bot: Bot | null,
  config: StudioTimeConfig,
  event: { postKey: string | null; detailsJson: unknown },
): Promise<void> {
  if (!bot) return;
  const details = object(event.detailsJson);
  // `admin_id` is the pre-rename spelling. Domain events are durable, so rows
  // written before 0030 are still queued here and must resolve to the same owner.
  const actorId = number(details.actor_id) ?? number(details.admin_id) ?? ownerForRef(backendDb, event.postKey);
  if (actorId == null || !notificationPreference(backendDb, actorId).remindersEnabled) return;
  const locale = botLocale(backendDb, actorId);
  const title = typeof details.title === "string" ? details.title : (event.postKey ?? t(locale, "notif.publication"));
  const targets = Array.isArray(details.targets) ? details.targets.filter((value): value is string => typeof value === "string") : [];
  const minutes = number(details.minutes) ?? 5;
  const publishAt = typeof details.publish_at === "string" ? details.publish_at : null;
  await bot.api.sendMessage(
    actorId,
    `${t(locale, "notif.reminder-head", { minutes })}\n\n${title}\n${targets.length ? `• ${targets.join(", ")}` : ""}${publishAt ? `\n\n${formatVideoTime(publishAt, locale, config)}` : ""}`.trim(),
    { reply_markup: new InlineKeyboard().text(t(locale, "settings.notifications"), "notifications_home") },
  );
}

export async function sendStudioCompletion(
  backendDb: BackendDb,
  bot: Bot | null,
  event: { postKey: string | null; detailsJson: unknown },
): Promise<void> {
  if (!bot) return;
  const actorId = ownerForRef(backendDb, event.postKey);
  if (actorId == null || !notificationPreference(backendDb, actorId).completionEnabled) return;
  const details = object(event.detailsJson);
  const total = number(details.total) ?? 0;
  const published = number(details.published) ?? 0;
  const failed = number(details.failed) ?? 0;
  const locale = botLocale(backendDb, actorId);
  const label = event.postKey?.startsWith("video:") ? t(locale, "notif.label-video") : t(locale, "notif.label-post");
  const text = failed
    ? t(locale, "notif.completion-failed", { label, published, total, failed })
    : t(locale, "notif.completion-ok", { label, done: published || total, total });
  await bot.api.sendMessage(actorId, text, {
    reply_markup: new InlineKeyboard().text(t(locale, "settings.notifications"), "notifications_home"),
  });
}

function notificationPreference(backendDb: BackendDb, actorId: number) {
  const row = backendDb.db.select().from(studioNotificationSettings).where(eq(studioNotificationSettings.actorId, actorId)).get();
  return { remindersEnabled: row?.remindersEnabled !== 0, completionEnabled: row?.completionEnabled !== 0 };
}

function ownerForRef(backendDb: BackendDb, ref: string | null): number | null {
  const match = ref?.match(/^(post|video):(\d+)$/);
  if (!match) return null;
  if (match[1] === "video")
    return (
      backendDb.db
        .select({ actorId: videoDrafts.actorId })
        .from(videoDrafts)
        .where(eq(videoDrafts.id, Number(match[2])))
        .get()?.actorId ?? null
    );
  return (
    backendDb.db
      .select({ actorId: drafts.actorId })
      .from(drafts)
      .where(eq(drafts.postId, Number(match[2])))
      .get()?.actorId ?? null
  );
}

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
