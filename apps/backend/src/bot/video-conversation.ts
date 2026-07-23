import { type Context, InlineKeyboard } from "grammy";
import { fixUrlSlashes } from "../content/message.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { sendTelegramDeliveryPreviews } from "../interfaces/telegram/delivery-previews.js";
import { describeError, t } from "../interfaces/telegram/i18n/index.js";
import { storeTelegramVideo } from "../interfaces/telegram/video-ingress.js";
import { videoPreview } from "../interfaces/telegram/video-preview.js";
import { type VideoMetadata, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { studioServices } from "../studio/services/index.js";
import {
  advanceVideoMetadata,
  advanceVideoTargetSchedule,
  commonVideoSchedule,
  firstVideoMetadataStep,
  type VideoWizardStep,
} from "../studio/video-fsm.js";
import { botLocale } from "./i18n.js";
import {
  askInstagramOrSchedule,
  askSchedule,
  clearSession,
  enabledVideoTargets,
  getSession,
  replyVideoPrompt,
  saveSession,
  sendVideoControl,
  sendVideoMetadataPrompt,
  sendVideoTimePrompt,
  setData,
  targetKeyboard,
  type VideoSession,
} from "./video-session.js";

/** Starts and advances the MP4 → metadata → schedule conversation. */
export async function startVideoConversation(ctx: Context, backendDb: BackendDb): Promise<void> {
  const adminId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, adminId);
  const text = t(locale, "video.dialog-prompt");
  const keyboard = new InlineKeyboard().text(t(locale, "common.cancel"), "video_cancel_dialog");
  // Reached via a menu button, this is pure navigation: turn that same
  // message into the prompt instead of leaving it and adding a new one.
  if (ctx.callbackQuery?.message) await ctx.editMessageText(text, { reply_markup: keyboard });
  else await ctx.reply(text, { reply_markup: keyboard });
  saveSession(backendDb, adminId, { draftId: null, step: "asset", selected: [], data: {} });
}

export async function handleVideoConversationMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  if (!config.studio.modules.video_posting) return false;
  const adminId = Number(ctx.from?.id);
  const session = getSession(backendDb, adminId);
  if (!session) return false;
  try {
    if (session.step === "asset") {
      const stored = await storeTelegramVideo(ctx, backendDb, config, adminId);
      const draftId = studioServices(backendDb, config).publications.create(adminId, {
        kind: "video",
        studioMediaAssetId: stored.assetId,
      }).id;
      const selected = enabledVideoTargets(config);
      if (!selected.length) throw new StudioError("err.no-video-platforms-config");
      studioServices(backendDb, config).videos.replaceTargets(adminId, draftId, selected);
      const first = firstVideoMetadataStep(selected);
      const next = { ...session, draftId, step: first.step, selected };
      saveSession(backendDb, adminId, next);
      await sendVideoMetadataPrompt(ctx, backendDb, adminId, first.step, selected);
      return true;
    }
    const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
    if (!text) {
      await replyVideoPrompt(ctx, botLocale(backendDb, adminId), t(botLocale(backendDb, adminId), "video.await-text"));
      return true;
    }
    if (!session.draftId) return false;
    if (session.data.is_single_edit) {
      const edit = singleEditChange(backendDb, config, adminId, session.step, text);
      if (edit) {
        await finishSingleVideoEdit(ctx, backendDb, config, adminId, session, edit.target, edit.apply);
        return true;
      }
    }
    if (session.step.startsWith("youtube_")) return handleYouTubeMessage(ctx, backendDb, config, adminId, session, text);
    if (session.step === "label") {
      studioServices(backendDb, config).videos.rename(adminId, session.draftId, text);
      if (session.data.is_single_edit) {
        clearSession(backendDb, adminId);
        const locale = botLocale(backendDb, adminId);
        const preview = videoPreview(backendDb, session.draftId, locale);
        await sendFreshVideoCard(ctx, backendDb, session.draftId, preview);
        return true;
      }
      const next = { ...session, step: "targets" };
      saveSession(backendDb, adminId, next);
      await sendVideoControl(
        ctx,
        backendDb,
        adminId,
        next,
        t(botLocale(backendDb, adminId), "video.choose-platforms-next"),
        targetKeyboard(config, session.selected, botLocale(backendDb, adminId)),
      );
      return true;
    }
    if (session.step === "instagram_caption") {
      const transition = advanceVideoMetadata("instagram_caption", text, session.data);
      const metadata = { caption: String(transition.data.instagram_caption ?? "") };
      studioServices(backendDb, config).videos.updateMetadata(adminId, session.draftId, "instagram_reels", metadata);
      if (!session.selected.includes("youtube_shorts"))
        studioServices(backendDb, config).videos.rename(adminId, session.draftId, metadata.caption || "Instagram Reels");
      await askSchedule(ctx, backendDb, adminId, session);
      return true;
    }
    if (session.step === "schedule_common" || session.step.startsWith("schedule_target:"))
      return handleScheduleMessage(ctx, backendDb, config, adminId, session, text);
  } catch (error) {
    const locale = botLocale(backendDb, adminId);
    await replyVideoPrompt(ctx, locale, `🔴 ${t(locale, "video.value-error")}: ${describeError(locale, error)}`);
    return true;
  }
  return false;
}

/** Steps where the FSM data key is the step name itself, so a single generic
 * handler can drive them: advance → store the field under its own name →
 * prompt whatever step the FSM says comes next. */
const YOUTUBE_LINEAR_STEPS: VideoWizardStep[] = ["youtube_title", "youtube_description", "youtube_game_url"];

async function handleYouTubeMessage(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: VideoSession,
  text: string,
): Promise<boolean> {
  if (session.draftId == null) return false;
  if (YOUTUBE_LINEAR_STEPS.includes(session.step as VideoWizardStep)) {
    const step = session.step as VideoWizardStep;
    const transition = advanceVideoMetadata(step, text, session.data);
    if (!transition.nextStep) throw new StudioError("err.video-restart");
    setData(backendDb, adminId, session, step, transition.data[step], transition.nextStep);
    await sendVideoMetadataPrompt(ctx, backendDb, adminId, transition.nextStep, session.selected);
    return true;
  }
  if (session.step !== "youtube_tags") return false;
  const transition = advanceVideoMetadata("youtube_tags", text, session.data);
  const tags = transition.data.youtube_tags as string[];
  const metadata = {
    title: String(session.data.youtube_title ?? ""),
    description: String(session.data.youtube_description ?? ""),
    ...(String(session.data.youtube_game_url ?? "") ? { gameUrl: String(session.data.youtube_game_url) } : {}),
    tags,
  };
  studioServices(backendDb, config).videos.updateMetadata(adminId, session.draftId, "youtube_shorts", metadata);
  studioServices(backendDb, config).videos.rename(adminId, session.draftId, metadata.title || "YouTube Shorts");
  await askInstagramOrSchedule(ctx, backendDb, adminId, session);
  return true;
}

/** Table for editing one already-set metadata field outside the wizard order
 * (reached via "✏️ Edit" on a finished draft). Kept separate from the wizard
 * advance logic above so neither has to know about the other's entry point. */
function singleEditChange(
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  step: string,
  text: string,
): { target: VideoTarget; apply: (metadata: Record<string, unknown>, draftId: number) => void } | null {
  if (step === "youtube_title")
    return {
      target: "youtube_shorts",
      apply: (metadata, draftId) => {
        metadata.title = text;
        studioServices(backendDb, config).videos.rename(adminId, draftId, text || "YouTube Shorts");
      },
    };
  if (step === "youtube_description")
    return {
      target: "youtube_shorts",
      apply: (metadata) => {
        metadata.description = text === "-" ? "" : text;
      },
    };
  if (step === "youtube_game_url")
    return {
      target: "youtube_shorts",
      apply: (metadata) => {
        metadata.gameUrl = text === "-" ? undefined : fixUrlSlashes(text);
      },
    };
  if (step === "youtube_tags")
    return {
      target: "youtube_shorts",
      apply: (metadata) => {
        metadata.tags = advanceVideoMetadata("youtube_tags", text, {}).data.youtube_tags as string[];
      },
    };
  if (step === "instagram_caption")
    return {
      target: "instagram_reels",
      apply: (metadata) => {
        metadata.caption = text === "-" ? "" : text;
        delete metadata.hashtags;
      },
    };
  return null;
}

/** Isolates the one step that legitimately fails on bad user input. Any other
 * error in this flow (preview, delivery, storage) must reach the generic
 * describeError path instead of being misreported as an unparsable date. */
async function parseScheduleDate(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  draftId: number,
  text: string,
): Promise<Date | null> {
  try {
    return studioServices(backendDb, config).videos.parseSchedule(adminId, draftId, text);
  } catch {
    await replyVideoPrompt(ctx, botLocale(backendDb, adminId), t(botLocale(backendDb, adminId), "common.schedule-parse-error"));
    return null;
  }
}

async function handleScheduleMessage(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: VideoSession,
  text: string,
): Promise<boolean> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  const date = await parseScheduleDate(ctx, backendDb, config, adminId, session.draftId, text);
  if (!date) return true;
  await applyVideoScheduleDate(ctx, backendDb, config, adminId, session, date);
  return true;
}

/** Applies one parsed/picked date to the current schedule step, whether it
 * came from free text or a slot button. Shared so the "different time per
 * platform" chain (schedule_target:X → next target) behaves identically
 * either way. */
export async function applyVideoScheduleDate(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: VideoSession,
  date: Date,
): Promise<void> {
  if (session.draftId == null) throw new StudioError("err.video-missing");
  if (session.step === "schedule_common") {
    await confirmVideoSchedule(ctx, backendDb, config, adminId, session, commonVideoSchedule(session.selected, date));
    return;
  }
  const target = session.step.slice("schedule_target:".length) as VideoTarget;
  const transition = advanceVideoTargetSchedule(
    session.selected,
    (session.data.schedule as Record<string, string> | undefined) ?? {},
    target,
    date,
  );
  if (transition.nextTarget) {
    const next = { ...session, step: `schedule_target:${transition.nextTarget}`, data: { ...session.data, schedule: transition.schedule } };
    saveSession(backendDb, adminId, next);
    await sendVideoTimePrompt(
      ctx,
      backendDb,
      adminId,
      next,
      t(botLocale(backendDb, adminId), "video.schedule-target-prompt", { target: videoTargetLabel(transition.nextTarget) }),
    );
    return;
  }
  await confirmVideoSchedule(
    ctx,
    backendDb,
    config,
    adminId,
    session,
    Object.fromEntries(Object.entries(transition.schedule).map(([key, value]) => [key, new Date(value)])) as Partial<
      Record<VideoTarget, Date>
    >,
  );
}

async function confirmVideoSchedule(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: VideoSession,
  schedule: Partial<Record<VideoTarget, Date>>,
): Promise<void> {
  if (!session.draftId) throw new StudioError("err.video-missing");
  const locale = botLocale(backendDb, adminId);
  const next = {
    ...session,
    step: "schedule_confirm",
    data: {
      ...session.data,
      schedule: Object.fromEntries(Object.entries(schedule).map(([target, value]) => [target, value?.toISOString()])),
    },
  };
  saveSession(backendDb, adminId, next);
  const delivery = studioServices(backendDb, config).videos.preview(adminId, session.draftId).delivery;
  await sendTelegramDeliveryPreviews(ctx, delivery.projections, botLocale(backendDb, adminId));
  const lines = [`🎬 *${t(locale, "common.confirm-schedule")}*`];
  for (const target of next.selected) {
    const value = schedule[target];
    if (value)
      lines.push(
        `${videoTargetLabel(target)}: ${value.toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { timeZone: config.TIMEZONE })} ${config.TIMEZONE_LABEL}`,
      );
  }
  const keyboard = new InlineKeyboard()
    .text(t(locale, "common.confirm"), `video_schedule_confirm:${session.draftId}`)
    .text(t(locale, "common.back"), `video_schedule:${session.draftId}`);
  await sendVideoControl(ctx, backendDb, adminId, next, lines.join("\n"), keyboard);
}

async function finishSingleVideoEdit(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: VideoSession,
  target: VideoTarget,
  change: (metadata: Record<string, unknown>, draftId: number) => void,
): Promise<void> {
  if (session.draftId == null) throw new StudioError("err.video-reopen-edit");
  const row = studioServices(backendDb, config)
    .videos.get(adminId, session.draftId)
    .targets.find((item) => item.target === target);
  const metadata = { ...(row?.metadataJson as Record<string, unknown> | undefined) };
  change(metadata, session.draftId);
  studioServices(backendDb, config).videos.updateMetadata(adminId, session.draftId, target, metadata as VideoMetadata);
  clearSession(backendDb, adminId);
  const locale = botLocale(backendDb, adminId);
  const preview = videoPreview(backendDb, session.draftId, locale);
  await sendFreshVideoCard(ctx, backendDb, session.draftId, preview);
}

/** A completed edit gets a fresh card at the bottom, same as post edits: the
 * previous card is history to scroll back to, never a moving prompt. */
async function sendFreshVideoCard(
  ctx: Context,
  backendDb: BackendDb,
  draftId: number,
  preview: { text: string; keyboard: InlineKeyboard },
): Promise<void> {
  const message = await ctx.reply(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  if (ctx.chat?.id) setTelegramVideoCard(backendDb, draftId, Number(ctx.chat.id), message.message_id);
}
