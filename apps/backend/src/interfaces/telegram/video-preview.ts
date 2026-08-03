import { InlineKeyboard } from "grammy";
import type { BotLocale } from "../../bot/i18n.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import { escapeMarkdown } from "../../foundation/markdown.js";
import { isVideoTargetEditable, isVideoTargetSchedulable } from "../../publishing/state.js";
import type { InstagramMetadata, YouTubeMetadata } from "../../publishing/video-types.js";
import { formatVideoTime } from "./video-time.js";

type VideoPreviewData = {
  draft: { id: number; label: string; locale: string; status: string };
  targets: Array<{ id: number; target: string; status: string; metadataJson: unknown; scheduledAt: string | null }>;
};

/** Telegram-only representation of a video draft. The video domain itself
 * exposes data and operations, never grammY markup or interface language. */
export function videoPreview(
  data: VideoPreviewData,
  config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">,
  locale: BotLocale = "ru",
): { text: string; keyboard: InlineKeyboard } {
  const { draft, targets } = data;
  const title = draft.label || t(locale, "vpreview.title-fallback");
  const lines = [
    `🎬 *${escapeMarkdown(title)}*`,
    `${t(locale, "vpreview.language")}: *${draft.locale.toUpperCase()}*`,
    `${t(locale, "vpreview.status")}: *${videoStatusLabel(draft.status, locale)}*`,
  ];
  const keyboard = new InlineKeyboard();
  const ytTarget = targets.find((target) => target.target === "youtube_shorts");
  const igTarget = targets.find((target) => target.target === "instagram_reels");
  if (ytTarget) {
    const metadata = (ytTarget.metadataJson ?? {}) as Partial<YouTubeMetadata>;
    lines.push("", "▶️ *YouTube Shorts*", `${t(locale, "vpreview.yt-title-label")}: ${escapeMarkdown(metadata.title || "—")}`);
    if (metadata.description) lines.push(`${t(locale, "vpreview.description")}: ${escapeMarkdown(metadata.description)}`);
    if (metadata.gameUrl) lines.push(`${t(locale, "vpreview.game")}: ${escapeMarkdown(metadata.gameUrl)}`);
    if (metadata.tags?.length) lines.push(`${t(locale, "vpreview.tags")}: ${escapeMarkdown(metadata.tags.join(", "))}`);
    lines.push(
      `${t(locale, "vpreview.state")}: ${videoStatusLabel(ytTarget.status, locale)}${ytTarget.scheduledAt ? ` · ${formatVideoTime(ytTarget.scheduledAt, locale, config)}` : ""}`,
    );
    if (isVideoTargetSchedulable(ytTarget.status)) keyboard.text(t(locale, "vpreview.yt-time"), `video_time:youtube_shorts:${draft.id}`);
    if (isVideoTargetEditable(ytTarget.status))
      keyboard.text(t(locale, "vpreview.yt-remove"), `video_remove_ask:youtube_shorts:${draft.id}`).row();
  }
  if (igTarget) {
    const metadata = (igTarget.metadataJson ?? {}) as Partial<InstagramMetadata>;
    lines.push("", "📸 *Instagram Reels*", `${t(locale, "vpreview.description")}: ${escapeMarkdown(metadata.caption || "—")}`);
    lines.push(
      `${t(locale, "vpreview.state")}: ${videoStatusLabel(igTarget.status, locale)}${igTarget.scheduledAt ? ` · ${formatVideoTime(igTarget.scheduledAt, locale, config)}` : ""}`,
    );
    if (isVideoTargetSchedulable(igTarget.status)) keyboard.text(t(locale, "vpreview.ig-time"), `video_time:instagram_reels:${draft.id}`);
    if (isVideoTargetEditable(igTarget.status))
      keyboard.text(t(locale, "vpreview.ig-remove"), `video_remove_ask:instagram_reels:${draft.id}`).row();
    if (igTarget.status === "failed" || igTarget.status === "verification_required")
      keyboard.text(t(locale, "vpreview.ig-retry"), `video_retry:instagram_reels:${draft.id}`).row();
  }
  if (ytTarget?.status === "failed" || ytTarget?.status === "verification_required")
    keyboard.text(t(locale, "vpreview.yt-retry"), `video_retry:youtube_shorts:${draft.id}`).row();
  // Publishing now and scheduling are the same pair of choices a text post
  // offers on its own card. The immediate path was implemented end to end
  // (video_now -> video_now_confirm) but no keyboard ever emitted it, so a
  // video could only be scheduled.
  if (targets.length > 0 && (draft.status === "draft" || draft.status === "editing"))
    keyboard
      .text(t(locale, "post.publish-now-btn"), `video_now:${draft.id}`)
      .row()
      .text(t(locale, "post.schedule-btn"), `video_schedule:${draft.id}`)
      .row();
  if (["draft", "editing"].includes(draft.status) && targets.every((target) => isVideoTargetEditable(target.status)))
    keyboard.text(t(locale, "vpreview.edit-details"), `video_edit_menu:${draft.id}`).row();
  keyboard.text(t(locale, "vpreview.cancel-pub"), `video_cancel_ask:${draft.id}`).row();
  keyboard.text(t(locale, "vpreview.back-queue"), "queue_home");
  return { text: lines.join("\n"), keyboard };
}

function videoStatusLabel(status: string, locale: BotLocale): string {
  const labels: Record<string, string> = {
    editing: t(locale, "vstatus.editing"),
    draft: t(locale, "vstatus.draft"),
    scheduled: t(locale, "vstatus.scheduled"),
    preparing: t(locale, "vstatus.preparing"),
    prepared: t(locale, "vstatus.prepared"),
    publishing: t(locale, "vstatus.publishing"),
    published: t(locale, "vstatus.published"),
    failed: t(locale, "vstatus.failed"),
    cancelled: t(locale, "vstatus.cancelled"),
  };
  return labels[status] ?? status;
}
