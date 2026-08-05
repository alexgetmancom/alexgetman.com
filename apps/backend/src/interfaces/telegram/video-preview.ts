import { InlineKeyboard } from "grammy";
import { confirmationKeyboard } from "../../bot/dialog-ui.js";
import type { BotLocale } from "../../bot/i18n.js";
import { publicationCallback } from "../../bot/publication-callback.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import { escapeMarkdown } from "../../foundation/markdown.js";
import { isVideoTargetEditable, isVideoTargetMetadataEditable, isVideoTargetSchedulable } from "../../publishing/state.js";
import { type InstagramMetadata, type VideoTarget, videoTargetLabel, type YouTubeMetadata } from "../../publishing/video-types.js";
import { formatVideoTime } from "./video-time.js";

export type VideoPreviewData = {
  draft: { id: number; label: string; locale: string; status: string };
  targets: Array<{ id: number; target: string; status: string; metadataJson: unknown; scheduledAt: string | null }>;
};

export type VideoPreviewView = "overview" | "confirm_now" | "confirm_cancel" | "confirm_remove";

export function isVideoPreviewView(value: string | undefined): value is VideoPreviewView {
  return value === "overview" || value === "confirm_now" || value === "confirm_cancel" || value === "confirm_remove";
}

export type VideoPreviewOptions = {
  view?: VideoPreviewView | undefined;
  revision?: number | null | undefined;
  target?: VideoTarget | undefined;
};

/** Telegram-only representation of a video draft. The video domain itself
 * exposes data and operations, never grammY markup or interface language. */
export function videoPreview(
  data: VideoPreviewData,
  config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">,
  locale: BotLocale,
  options: VideoPreviewOptions = {},
): { text: string; keyboard: InlineKeyboard } {
  const { draft, targets } = data;
  const title = draft.label || t(locale, "vpreview.title-fallback");
  const lines = [
    `🎬 *${escapeMarkdown(title)}*`,
    `${t(locale, "vpreview.language")}: *${draft.locale.toUpperCase()}*`,
    `${t(locale, "vpreview.status")}: *${videoStatusLabel(draft.status, locale)}*`,
  ];
  const keyboard = new InlineKeyboard();
  const view = options.view ?? "overview";
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
    if (isVideoTargetSchedulable(ytTarget.status))
      keyboard.text(t(locale, "vpreview.yt-time"), publicationCallback("video", "time", [draft.id, "youtube_shorts"]));
    if (isVideoTargetEditable(ytTarget.status))
      keyboard.text(t(locale, "vpreview.yt-remove"), publicationCallback("video", "remove_ask", [draft.id, "youtube_shorts"])).row();
  }
  if (igTarget) {
    const metadata = (igTarget.metadataJson ?? {}) as Partial<InstagramMetadata>;
    lines.push("", "📸 *Instagram Reels*", `${t(locale, "vpreview.description")}: ${escapeMarkdown(metadata.caption || "—")}`);
    lines.push(
      `${t(locale, "vpreview.state")}: ${videoStatusLabel(igTarget.status, locale)}${igTarget.scheduledAt ? ` · ${formatVideoTime(igTarget.scheduledAt, locale, config)}` : ""}`,
    );
    if (isVideoTargetSchedulable(igTarget.status))
      keyboard.text(t(locale, "vpreview.ig-time"), publicationCallback("video", "time", [draft.id, "instagram_reels"]));
    if (isVideoTargetEditable(igTarget.status))
      keyboard.text(t(locale, "vpreview.ig-remove"), publicationCallback("video", "remove_ask", [draft.id, "instagram_reels"])).row();
    if (igTarget.status === "failed" || igTarget.status === "verification_required")
      keyboard.text(t(locale, "vpreview.ig-retry"), publicationCallback("video", "retry", [draft.id, "instagram_reels", "card"])).row();
  }
  if (ytTarget?.status === "failed" || ytTarget?.status === "verification_required")
    keyboard.text(t(locale, "vpreview.yt-retry"), publicationCallback("video", "retry", [draft.id, "youtube_shorts", "card"])).row();
  if (view !== "overview") return videoConfirmationPreview(draft.id, lines.join("\n"), locale, view, options);
  // Publishing now and scheduling are the same pair of choices a text post
  // offers on its own card, and both use the shared publication actions.
  if (targets.length > 0 && (draft.status === "draft" || draft.status === "editing"))
    keyboard
      .text(t(locale, "post.publish-now-btn"), publicationCallback("video", "publish", [draft.id]))
      .row()
      .text(t(locale, "post.schedule-btn"), publicationCallback("video", "schedule", [draft.id]))
      .row();
  if (["draft", "editing", "scheduled"].includes(draft.status) && targets.some((target) => isVideoTargetMetadataEditable(target.status)))
    keyboard.text(t(locale, "vpreview.edit-details"), publicationCallback("video", "edit_menu", [draft.id])).row();
  keyboard.text(t(locale, "vpreview.cancel-pub"), publicationCallback("video", "cancel", [draft.id, "confirm_cancel"])).row();
  keyboard.text(t(locale, "queue.back-btn"), "queue_home");
  return { text: lines.join("\n"), keyboard };
}

function videoConfirmationPreview(
  draftId: number,
  overviewText: string,
  locale: BotLocale,
  view: Exclude<VideoPreviewView, "overview">,
  options: VideoPreviewOptions,
): { text: string; keyboard: InlineKeyboard } {
  if (view === "confirm_now") {
    return {
      text: `${overviewText}\n\n${t(locale, "video.publish-now-q")}`,
      keyboard: confirmationKeyboard(
        { label: t(locale, "video.publish-now-yes"), callback: publicationCallback("video", "publish_confirm", [draftId]) },
        { label: t(locale, "common.back"), callback: publicationCallback("video", "view", [draftId, "overview"]) },
        options.revision,
      ),
    };
  }
  if (view === "confirm_cancel") {
    return {
      text: `${overviewText}\n\n⚠️ *${t(locale, "vpreview.cancel-confirm-q")}*\n${t(locale, "vpreview.cancel-confirm-warn")}`,
      keyboard: confirmationKeyboard(
        { label: t(locale, "vpreview.cancel-yes"), callback: publicationCallback("video", "cancel_confirm", [draftId]) },
        { label: t(locale, "common.back"), callback: publicationCallback("video", "view", [draftId, "overview"]) },
        options.revision,
      ),
    };
  }
  const target = options.target;
  if (!target) throw new Error("Video removal confirmation target is missing.");
  const label = videoTargetLabel(target);
  return {
    text: `${overviewText}\n\n⚠️ *${t(locale, "vpreview.remove-confirm-q", { target: label })}*\n${t(locale, "vpreview.remove-confirm-warn", { target: label })}`,
    keyboard: confirmationKeyboard(
      { label: t(locale, "vpreview.remove-yes", { target: label }), callback: publicationCallback("video", "remove", [draftId, target]) },
      { label: t(locale, "common.back"), callback: publicationCallback("video", "view", [draftId, "overview"]) },
      options.revision,
    ),
  };
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
    verification_required: t(locale, "vstatus.verification-required"),
    cancelled: t(locale, "vstatus.cancelled"),
  };
  return labels[status] ?? status;
}
