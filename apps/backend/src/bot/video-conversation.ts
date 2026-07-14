import { type Context, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
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
import { botLocale, ui } from "./i18n.js";
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
  await ctx.reply(
    ui(
      locale,
      "🎬 Send an MP4 video. I will ask only for the details that are needed.",
      "🎬 Пришлите видео MP4. Затем я задам только нужные вопросы.",
    ),
    { reply_markup: new InlineKeyboard().text(ui(locale, "← Cancel", "← Отмена"), "video_cancel_dialog") },
  );
  saveSession(backendDb, adminId, { draftId: null, step: "asset", selected: [], data: {} });
}

export async function handleVideoConversationMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  if (!config.studio.modules.video_posting) return false;
  const adminId = Number(ctx.from?.id);
  const session = getSession(backendDb, adminId);
  if (!session) return false;
  try {
    if (session.step === "asset") {
      const stored = await storeTelegramVideo(ctx, config);
      const draftId = studioServices(backendDb, config).videos.create(adminId, stored.assetKey);
      const selected = enabledVideoTargets(config);
      if (!selected.length) throw new Error("No video platforms are enabled in studio.yaml.");
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
      await replyVideoPrompt(ctx, "⌨ Сейчас жду текстовый ответ. Нажмите «☰ Показать меню», чтобы начать другой сценарий.");
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
        ui(botLocale(backendDb, adminId), "Choose platforms, then tap Next.", "Выберите платформы, затем нажмите «Далее»."),
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
      await replyVideoPrompt(
        ctx,
        ui(
          locale,
          "I couldn't read that date and time. Send `HH:MM` or `DD.MM HH:MM` in MSK, for example `15.07 18:30`.",
          "Не удалось распознать дату и время. Отправьте `ЧЧ:ММ` или `ДД.ММ ЧЧ:ММ` по МСК, например `15.07 18:30`.",
        ),
      );
    else
      await replyVideoPrompt(
        ctx,
        `🔴 ${ui(locale, "I couldn't use that value", "Не удалось обработать значение")}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      reply_markup: new InlineKeyboard().text("⏭ Пропустить", "video_game_skip"),
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
  if (prompt === "youtube_title") return ui(locale, "⌨ Title for YouTube Shorts?", "⌨ Название для YouTube Shorts?");
  if (prompt === "youtube_description")
    return ui(locale, "⌨ YouTube description (send `-` to skip):", "⌨ Описание для YouTube (отправьте `-`, если не нужно):");
  if (prompt === "youtube_game_url") return ui(locale, "📀 Steam or game page URL?", "📀 Ссылка на Steam или страницу игры?");
  if (prompt === "youtube_tags") return ui(locale, "⌨ YouTube tags, comma-separated (or `-`):", "⌨ Теги YouTube через запятую (или `-`):");
  if (prompt === "instagram_caption")
    return ui(
      locale,
      "⌨ Caption for Instagram Reels, including hashtags (or `-`)?",
      "⌨ Подпись для Instagram Reels вместе с хэштегами (или `-`)?",
    );
  return ui(locale, "⌨ When should it be published?", "⌨ Когда опубликовать?");
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
    await confirmVideoSchedule(ctx, backendDb, adminId, session, commonVideoSchedule(session.selected, date));
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
    await replyVideoPrompt(ctx, `⌨ Когда опубликовать на ${videoTargetLabel(transition.nextTarget)}? Формат: 15.07 18:30 (МСК).`);
    return true;
  }
  await confirmVideoSchedule(
    ctx,
    backendDb,
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
  adminId: number,
  session: VideoSession,
  schedule: Partial<Record<VideoTarget, Date>>,
): Promise<void> {
  if (!session.draftId) throw new Error("Video draft is missing.");
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
  const lines = [`🎬 *${ui(locale, "Confirm schedule", "Подтвердите планирование")}*`];
  for (const target of next.selected) {
    const value = schedule[target];
    if (value)
      lines.push(
        `${videoTargetLabel(target)}: ${value.toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { timeZone: "Europe/Moscow" })} MSK`,
      );
  }
  const keyboard = new InlineKeyboard()
    .text(ui(locale, "✅ Confirm", "✅ Подтвердить"), `video_schedule_confirm:${session.draftId}`)
    .text(ui(locale, "← Back", "← Назад"), `video_schedule:${session.draftId}`);
  await updateVideoControl(ctx, next, lines.join("\n"), keyboard);
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
  if (session.draftId == null) throw new Error("Откройте редактирование видео заново.");
  const row = studioServices(backendDb, config)
    .videos.details(adminId, session.draftId)
    .targets.find((item) => item.target === target);
  const metadata = { ...(row?.metadataJson as Record<string, unknown> | undefined) };
  change(metadata, session.draftId);
  studioServices(backendDb, config).videos.updateMetadata(adminId, session.draftId, target, metadata as VideoMetadata);
  clearSession(backendDb, adminId);
  const preview = videoPreview(backendDb, session.draftId, botLocale(backendDb, adminId));
  await updateVideoControl(ctx, session, preview.text, preview.keyboard);
}
