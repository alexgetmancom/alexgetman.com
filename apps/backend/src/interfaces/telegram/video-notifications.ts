import { desc, eq } from "drizzle-orm";
import { type Bot, InlineKeyboard } from "grammy";
import { botLocale } from "../../bot/i18n.js";
import { publicationCallback } from "../../bot/session-fsm.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { drafts, publishJobs, siteJobs, studioNotificationSettings, videoDrafts, videoTargets } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import { log } from "../../foundation/logger.js";
import { getVideoDraft, listVideoTargets } from "../../publishing/video-data.js";
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
  config: Pick<BackendConfig, "ADMIN_IDS">,
  videoDraftId: number,
  videoTargetId: number | null,
): Promise<void> {
  if (!bot || !videoTargetId) return;
  const target = unsafeDb(backendDb).db.select().from(videoTargets).where(eq(videoTargets.id, videoTargetId)).get();
  if (target?.status !== "failed") return;
  const draft = getVideoDraft(backendDb, videoDraftId);
  const targetName = target.target as VideoTarget;
  await forEachAdmin(config.ADMIN_IDS, async (actorId) => {
    const locale = botLocale(backendDb, actorId);
    const title = draft.label || t(locale, "common.untitled");
    await bot.api.sendMessage(
      actorId,
      `${t(locale, "notif.video-failed", { label: videoTargetLabel(targetName), title })}\n\n${target.lastError || t(locale, "notif.unknown-error")}`,
      {
        reply_markup: new InlineKeyboard().text(
          t(locale, "notif.retry", { platform: targetName === "youtube_shorts" ? "YouTube" : "Instagram" }),
          publicationCallback("video", "retry", [draft.id, targetName]),
        ),
      },
    );
  });
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
  const draft = getVideoDraft(backendDb, videoDraftId);
  const preview = videoPreview({ draft, targets: listVideoTargets(backendDb, videoDraftId) }, config, botLocale(backendDb, draft.actorId));
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
  config: StudioTimeConfig & Pick<BackendConfig, "ADMIN_IDS">,
  videoDraftId: number,
  videoTargetId: number | null,
): Promise<void> {
  const draft = getVideoDraft(backendDb, videoDraftId);
  const target =
    videoTargetId == null ? null : unsafeDb(backendDb).db.select().from(videoTargets).where(eq(videoTargets.id, videoTargetId)).get();
  if (!bot || !target || draft.status !== "scheduled") return;
  await forEachAdmin(config.ADMIN_IDS, async (actorId) => {
    const preference = notificationPreference(backendDb, actorId);
    if (!preference.remindersEnabled) return;
    const locale = botLocale(backendDb, actorId);
    const title = draft.label || t(locale, "common.untitled");
    const text = `${t(locale, "notif.reminder-head", { minutes: preference.reminderMinutes })}\n\n🎬 ${title}\n${draft.locale === "en" ? "🇬🇧 EN" : "🇷🇺 RU"}\n\n• ${videoTargetLabel(target.target as VideoTarget)}\n\n${formatVideoTime(target.scheduledAt, locale, config)}`;
    await bot.api.sendMessage(actorId, text, {
      reply_markup: new InlineKeyboard()
        .text(t(locale, "notif.open"), publicationCallback("video", "open", [draft.id]))
        .text(t(locale, "notif.cancel-btn"), publicationCallback("video", "cancel_notice", [draft.id])),
    });
  });
  unsafeDb(backendDb)
    .db.update(videoDrafts)
    .set({ reminderSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(videoDrafts.id, draft.id))
    .run();
}

/** Telegram delivery adapter for Studio events. The event and preference live above Telegram. */
export async function sendStudioReminder(
  backendDb: BackendDb,
  bot: Bot | null,
  config: StudioTimeConfig & Pick<BackendConfig, "ADMIN_IDS">,
  event: { postKey: string | null; detailsJson: unknown },
): Promise<void> {
  if (!bot) return;
  const details = object(event.detailsJson);
  // `admin_id` is the pre-rename spelling. Domain events are durable, so rows
  // written before 0030 are still queued here and must resolve to the same owner.
  const ownerId = number(details.actor_id) ?? number(details.admin_id) ?? ownerForRef(backendDb, event.postKey);
  if (ownerId == null) return;
  const targets = Array.isArray(details.targets) ? details.targets.filter((value): value is string => typeof value === "string") : [];
  const minutes = number(details.minutes) ?? 5;
  const publishAt = typeof details.publish_at === "string" ? details.publish_at : null;
  const videoLocale = videoLocaleForRef(backendDb, event.postKey);
  await forEachAdmin(config.ADMIN_IDS, async (actorId) => {
    if (!notificationPreference(backendDb, actorId).remindersEnabled) return;
    const locale = botLocale(backendDb, actorId);
    const title = typeof details.title === "string" ? details.title : (event.postKey ?? t(locale, "notif.publication"));
    const lines = targets.map((target) => `• ${friendlyTarget(target)}${videoLocale ? ` · ${videoLocale.toUpperCase()}` : ""}`);
    await bot.api.sendMessage(
      actorId,
      `${t(locale, "notif.reminder-head", { minutes })}\n\n🎬 ${title}${videoLocale ? `\n${videoLocale === "en" ? "🇬🇧 EN" : "🇷🇺 RU"}` : ""}\n\n${lines.join("\n")}${publishAt ? `\n\n${formatVideoTime(publishAt, locale, config)}` : ""}`.trim(),
      { reply_markup: new InlineKeyboard().text(t(locale, "settings.notifications"), "notifications_home") },
    );
  });
}

export async function sendStudioCompletion(
  backendDb: BackendDb,
  bot: Bot | null,
  config: Pick<BackendConfig, "ADMIN_IDS">,
  event: { postKey: string | null; detailsJson: unknown },
): Promise<void> {
  if (!bot) return;
  const ownerId = ownerForRef(backendDb, event.postKey);
  if (ownerId == null) return;
  const details = object(event.detailsJson);
  const total = number(details.total) ?? 0;
  const published = number(details.published) ?? 0;
  const failed = number(details.failed) ?? 0;
  const results = completionTargets(backendDb, event.postKey);
  const videoLocale = videoLocaleForRef(backendDb, event.postKey);
  const failedTargets = results.filter((result) => result.status === "failed" || result.status === "verification_required");
  const draftId = postDraftId(backendDb, event.postKey);
  await forEachAdmin(config.ADMIN_IDS, async (actorId) => {
    if (!notificationPreference(backendDb, actorId).completionEnabled) return;
    const locale = botLocale(backendDb, actorId);
    const label = event.postKey?.startsWith("video:") ? t(locale, "notif.label-video") : t(locale, "notif.label-post");
    const headline = failed
      ? t(locale, "notif.completion-failed", { label, published, total, failed })
      : t(locale, "notif.completion-ok", { label, done: published || total, total });
    const lines = results.map(
      (result) =>
        `${statusIcon(result.status)} ${friendlyTarget(result.target)} — ${friendlyStatus(result.status, locale)}${
          result.error && (result.status === "failed" || result.status === "verification_required") ? ` — ${shortError(result.error)}` : ""
        }`,
    );
    const text = `${headline}${videoLocale ? `\n${videoLocale === "en" ? "🇬🇧 EN" : "🇷🇺 RU"}` : ""}${lines.length ? `\n\n${lines.join("\n")}` : ""}`;
    await bot.api.sendMessage(actorId, text, {
      reply_markup: completionKeyboard(locale, event.postKey, draftId, failedTargets),
    });
  });
}

function completionKeyboard(
  locale: ReturnType<typeof botLocale>,
  postKey: string | null,
  draftId: number | null,
  failedTargets: Array<{ target: string; status: string; error: string | null }>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (postKey?.startsWith("post:") && draftId != null && failedTargets.length) {
    keyboard.text(t(locale, "notif.retry-failed"), publicationCallback("post", "post_retry_notice", [draftId])).row();
    keyboard.text(t(locale, "notif.open"), publicationCallback("post", "preview", [draftId])).row();
    for (const target of failedTargets)
      keyboard
        .text(
          t(locale, "notif.retry-target", { target: friendlyTarget(target.target) }),
          publicationCallback("post", "post_retry_notice", [draftId, target.target]),
        )
        .row();
  }
  if (postKey?.startsWith("video:") && draftId != null && failedTargets.length) {
    keyboard.text(t(locale, "notif.open"), publicationCallback("video", "open", [draftId])).row();
    for (const target of failedTargets)
      keyboard
        .text(
          t(locale, "notif.retry-target", { target: friendlyTarget(target.target) }),
          publicationCallback("video", "retry", [draftId, target.target]),
        )
        .row();
  }
  keyboard.text(t(locale, "settings.notifications"), "notifications_home");
  return keyboard;
}

async function forEachAdmin(actorIds: number[], deliver: (actorId: number) => Promise<void>): Promise<void> {
  for (const actorId of actorIds) {
    try {
      await deliver(actorId);
    } catch (error) {
      // One administrator blocking the bot must not prevent the remaining
      // trusted operators from receiving the shared publication update.
      log("warn", "shared Studio notification was not delivered", { actorId, error: String(error) });
    }
  }
}

function completionTargets(backendDb: BackendDb, ref: string | null): Array<{ target: string; status: string; error: string | null }> {
  const match = ref?.match(/^(post|video):(\d+)$/);
  if (!match) return [];
  if (match[1] === "video")
    return unsafeDb(backendDb)
      .db.select({ target: videoTargets.target, status: videoTargets.status, error: videoTargets.lastError })
      .from(videoTargets)
      .where(eq(videoTargets.videoDraftId, Number(match[2])))
      .all();
  const jobs = unsafeDb(backendDb)
    .db.select({ target: publishJobs.target, status: publishJobs.status, error: publishJobs.lastError, jobId: publishJobs.jobId })
    .from(publishJobs)
    .where(eq(publishJobs.postId, Number(match[2])))
    .orderBy(desc(publishJobs.jobId))
    .all();
  const latest = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) if (!latest.has(job.target)) latest.set(job.target, job);
  const site = unsafeDb(backendDb)
    .db.select({ reason: siteJobs.reason, status: siteJobs.status, error: siteJobs.lastError, jobId: siteJobs.jobId })
    .from(siteJobs)
    .where(eq(siteJobs.postId, Number(match[2])))
    .orderBy(desc(siteJobs.jobId))
    .all();
  for (const job of site) {
    const target = siteTarget(job.reason);
    if (target && !latest.has(target)) latest.set(target, { target, status: job.status, error: job.error, jobId: job.jobId });
  }
  return [...latest.values()];
}

function postDraftId(backendDb: BackendDb, ref: string | null): number | null {
  const match = ref?.match(/^post:(\d+)$/);
  if (!match) return null;
  return (
    unsafeDb(backendDb)
      .db.select({ id: drafts.id })
      .from(drafts)
      .where(eq(drafts.postId, Number(match[1])))
      .get()?.id ?? null
  );
}

function siteTarget(reason: string): string | null {
  if (reason === "publish_ru") return "site_ru";
  if (reason === "publish_en") return "site_en";
  return null;
}

function shortError(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 180);
}

function videoLocaleForRef(backendDb: BackendDb, ref: string | null): "ru" | "en" | null {
  const match = ref?.match(/^video:(\d+)$/);
  if (!match) return null;
  const locale = unsafeDb(backendDb)
    .db.select({ locale: videoDrafts.locale })
    .from(videoDrafts)
    .where(eq(videoDrafts.id, Number(match[1])))
    .get()?.locale;
  return locale === "en" ? "en" : locale === "ru" ? "ru" : null;
}

function friendlyTarget(target: string): string {
  const labels: Record<string, string> = {
    youtube_shorts: "YouTube Shorts",
    instagram_reels: "Instagram Reels",
    telegram: "Telegram",
    site_ru: "Site RU",
    site_en: "Site EN",
    threads_ru: "Threads RU",
    threads_en: "Threads EN",
    x: "X",
    telegram_stories: "Telegram Stories",
    instagram_stories_ru: "Instagram Stories RU",
    instagram_stories: "Instagram Stories EN",
  };
  return labels[target] ?? target;
}

function statusIcon(status: string): string {
  if (["published", "completed"].includes(status)) return "✅";
  if (status === "failed") return "❌";
  if (status === "verification_required") return "⚠️";
  if (status === "cancelled") return "🚫";
  return "⏳";
}

function friendlyStatus(status: string, locale: "ru" | "en"): string {
  const ru: Record<string, string> = {
    published: "опубликовано",
    completed: "опубликовано",
    failed: "ошибка",
    verification_required: "нужна проверка",
    cancelled: "отменено",
  };
  const en: Record<string, string> = {
    published: "published",
    completed: "published",
    failed: "failed",
    verification_required: "verification required",
    cancelled: "cancelled",
  };
  return (locale === "ru" ? ru : en)[status] ?? (locale === "ru" ? "ожидает" : "pending");
}

function notificationPreference(backendDb: BackendDb, actorId: number) {
  const row = unsafeDb(backendDb).db.select().from(studioNotificationSettings).where(eq(studioNotificationSettings.actorId, actorId)).get();
  return {
    remindersEnabled: row?.remindersEnabled !== 0,
    reminderMinutes: row?.reminderMinutes ?? 5,
    completionEnabled: row?.completionEnabled !== 0,
  };
}

function ownerForRef(backendDb: BackendDb, ref: string | null): number | null {
  const match = ref?.match(/^(post|video):(\d+)$/);
  if (!match) return null;
  if (match[1] === "video")
    return (
      unsafeDb(backendDb)
        .db.select({ actorId: videoDrafts.actorId })
        .from(videoDrafts)
        .where(eq(videoDrafts.id, Number(match[2])))
        .get()?.actorId ?? null
    );
  return (
    unsafeDb(backendDb)
      .db.select({ actorId: drafts.actorId })
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
