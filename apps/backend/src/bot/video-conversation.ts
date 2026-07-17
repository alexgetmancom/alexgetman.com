import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
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
  type VideoPrompt,
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
  setData,
  targetKeyboard,
  updateVideoControl,
  type VideoSession,
} from "./video-session.js";

/** Starts and advances the MP4 → metadata → schedule conversation. */
export async function startVideoConversation(ctx: Context, backendDb: BackendDb): Promise<void> {
  const adminId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, adminId);
  await ctx.reply(t(locale, "video.dialog-prompt"), {
    reply_markup: new InlineKeyboard().text(t(locale, "post.cancel"), "video_cancel_dialog"),
  });
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
      const draftId = studioServices(backendDb, config).videos.create(adminId, stored.assetId);
      const selected = enabledVideoTargets(config);
      if (!selected.length) throw new StudioError("err.no-video-platforms-config");
      studioServices(backendDb, config).videos.replaceTargets(adminId, draftId, selected);
      const first = firstVideoMetadataStep(selected);
      const next = { ...session, draftId, step: first.step, selected };
      saveSession(backendDb, adminId, next);
      const locale = botLocale(backendDb, adminId);
      await replyVideoPrompt(ctx, videoPrompt(locale, first.prompt));
      return true;
    }
    const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
    if (!text) {
      await replyVideoPrompt(ctx, t(botLocale(backendDb, adminId), "video.await-text"));
      return true;
    }
    if (!session.draftId) return false;
    if (session.step.startsWith("youtube_")) return handleYouTubeMessage(ctx, backendDb, config, adminId, session, text);
    if (session.step === "label") {
      studioServices(backendDb, config).videos.rename(adminId, session.draftId, text);
      if (session.data.is_single_edit) {
        clearSession(backendDb, adminId);
        const preview = videoPreview(backendDb, session.draftId, botLocale(backendDb, adminId));
        await updateVideoControl(ctx, session, preview.text, preview.keyboard);
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
        targetKeyboard(config, session.selected),
      );
      return true;
    }
    if (session.step === "instagram_caption") {
      if (session.data.is_single_edit) {
        await finishSingleVideoEdit(ctx, backendDb, config, adminId, session, "instagram_reels", (metadata) => {
          metadata.caption = text === "-" ? "" : text;
          delete metadata.hashtags;
        });
        return true;
      }
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
    if (session.step === "schedule_common" || session.step.startsWith("schedule_target:"))
      await replyVideoPrompt(ctx, t(locale, "post.schedule-parse-error"));
    else await replyVideoPrompt(ctx, `🔴 ${t(locale, "video.value-error")}: ${describeError(locale, error)}`);
    return true;
  }
  return false;
}

async function handleYouTubeMessage(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: VideoSession,
  text: string,
): Promise<boolean> {
  if (session.draftId == null) return false;
  if (session.step === "youtube_title") {
    if (session.data.is_single_edit) {
      await finishSingleVideoEdit(ctx, backendDb, config, adminId, session, "youtube_shorts", (metadata, draftId) => {
        metadata.title = text;
        studioServices(backendDb, config).videos.rename(adminId, draftId, text || "YouTube Shorts");
      });
      return true;
    }
    const transition = advanceVideoMetadata("youtube_title", text, session.data);
    setData(backendDb, adminId, session, "youtube_title", text, transition.nextStep ?? "youtube_description");
    await replyVideoPrompt(ctx, videoPrompt(botLocale(backendDb, adminId), transition.prompt));
    return true;
  }
  if (session.step === "youtube_description") {
    if (session.data.is_single_edit) {
      await finishSingleVideoEdit(ctx, backendDb, config, adminId, session, "youtube_shorts", (metadata) => {
        metadata.description = text === "-" ? "" : text;
      });
      return true;
    }
    const transition = advanceVideoMetadata("youtube_description", text, session.data);
    setData(
      backendDb,
      adminId,
      session,
      "youtube_description",
      transition.data.youtube_description,
      transition.nextStep ?? "youtube_game_url",
    );
    await ctx.reply(videoPrompt(botLocale(backendDb, adminId), transition.prompt), {
      reply_markup: new InlineKeyboard().text(t(botLocale(backendDb, adminId), "video.skip"), "video_game_skip"),
    });
    return true;
  }
  if (session.step === "youtube_game_url") {
    if (session.data.is_single_edit) {
      await finishSingleVideoEdit(ctx, backendDb, config, adminId, session, "youtube_shorts", (metadata) => {
        metadata.gameUrl = text === "-" ? undefined : text;
      });
      return true;
    }
    const transition = advanceVideoMetadata("youtube_game_url", text, session.data);
    setData(backendDb, adminId, session, "youtube_game_url", transition.data.youtube_game_url, transition.nextStep ?? "youtube_tags");
    await replyVideoPrompt(ctx, videoPrompt(botLocale(backendDb, adminId), transition.prompt));
    return true;
  }
  if (session.step !== "youtube_tags") return false;
  const transition = advanceVideoMetadata("youtube_tags", text, session.data);
  const tags = transition.data.youtube_tags as string[];
  if (session.data.is_single_edit) {
    await finishSingleVideoEdit(ctx, backendDb, config, adminId, session, "youtube_shorts", (metadata) => {
      metadata.tags = tags;
    });
    return true;
  }
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

function videoPrompt(locale: "en" | "ru", prompt: VideoPrompt): string {
  if (prompt === "youtube_title") return t(locale, "video.prompt-yt-title");
  if (prompt === "youtube_description") return t(locale, "video.prompt-yt-description");
  if (prompt === "youtube_game_url") return t(locale, "video.prompt-yt-game-url");
  if (prompt === "youtube_tags") return t(locale, "video.prompt-yt-tags");
  if (prompt === "instagram_caption") return t(locale, "video.prompt-ig-caption");
  return t(locale, "video.prompt-when-publish");
}

async function handleScheduleMessage(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: VideoSession,
  text: string,
): Promise<boolean> {
  if (session.step === "schedule_common") {
    const date = studioServices(backendDb, config).videos.parseSchedule(adminId, session.draftId ?? 0, text);
    await confirmVideoSchedule(ctx, backendDb, config, adminId, session, commonVideoSchedule(session.selected, date));
    return true;
  }
  const target = session.step.slice("schedule_target:".length) as VideoTarget;
  const transition = advanceVideoTargetSchedule(
    session.selected,
    (session.data.schedule as Record<string, string> | undefined) ?? {},
    target,
    studioServices(backendDb, config).videos.parseSchedule(adminId, session.draftId ?? 0, text),
  );
  if (transition.nextTarget) {
    saveSession(backendDb, adminId, {
      ...session,
      step: `schedule_target:${transition.nextTarget}`,
      data: { ...session.data, schedule: transition.schedule },
    });
    await replyVideoPrompt(
      ctx,
      t(botLocale(backendDb, adminId), "video.schedule-target-prompt", { target: videoTargetLabel(transition.nextTarget) }),
    );
    return true;
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
  return true;
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
  await sendTelegramDeliveryPreviews(ctx, delivery.projections);
  const lines = [`🎬 *${t(locale, "post.confirm-schedule-title")}*`];
  for (const target of next.selected) {
    const value = schedule[target];
    if (value)
      lines.push(
        `${videoTargetLabel(target)}: ${value.toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { timeZone: "Europe/Moscow" })} MSK`,
      );
  }
  const keyboard = new InlineKeyboard()
    .text(t(locale, "video.confirm"), `video_schedule_confirm:${session.draftId}`)
    .text(t(locale, "post.back"), `video_schedule:${session.draftId}`);
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
  const preview = videoPreview(backendDb, session.draftId, botLocale(backendDb, adminId));
  await updateVideoControl(ctx, session, preview.text, preview.keyboard);
}
