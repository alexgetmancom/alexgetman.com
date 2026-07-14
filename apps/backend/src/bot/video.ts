import { and, eq } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { videoJobs, videoTargets } from "../db/schema.js";
import { parseManualSchedule } from "../publishing/schedule.js";
import {
  cancelVideo,
  createVideoDraft,
  listVideoTargets,
  refreshVideoDraftStatus,
  replaceVideoTargets,
  retryFailedVideoTarget,
  saveVideoMetadata,
  setVideoControlCard,
  updateVideoLabel,
  videoPreview,
} from "../video/service.js";
import { storeTelegramVideo } from "../video/storage.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../video/types.js";
import { finishVideoSchedule } from "./video-scheduling.js";
import {
  askInstagramOrSchedule,
  askSchedule,
  callbackMessageId,
  clearSession,
  enabledVideoTargets,
  getSession,
  replyVideoPrompt,
  saveSession,
  sendVideoControl,
  setControlFromSession,
  setData,
  targetKeyboard,
  updateVideoControl,
  type VideoSession,
} from "./video-session.js";

export async function startVideoFlow(ctx: Context, backendDb: BackendDb): Promise<void> {
  const adminId = Number(ctx.from?.id);
  const cancelMarkup = new InlineKeyboard().text("← Cancel", "video_cancel_dialog");
  await ctx.reply("🎬 Пришлите видео MP4. Потом выберем площадки и заполним данные отдельно для каждой.", {
    reply_markup: cancelMarkup,
  });
  saveSession(backendDb, adminId, { draftId: null, step: "asset", selected: [], data: {} });
}

export async function handleVideoMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  if (!config.studio.modules.video_posting) return false;
  const adminId = Number(ctx.from?.id);
  const session = getSession(backendDb, adminId);
  if (!session) return false;
  try {
    if (session.step === "asset") {
      const stored = await storeTelegramVideo(ctx, config);
      const draftId = createVideoDraft(backendDb, adminId, stored.assetKey, config.VIDEO_MEDIA_RETENTION_HOURS);
      const selected = enabledVideoTargets(config);
      const next = { ...session, draftId, step: "targets", selected };
      saveSession(backendDb, adminId, next);
      await sendVideoControl(
        ctx,
        backendDb,
        adminId,
        next,
        "Куда публикуем? По умолчанию выбраны обе площадки.",
        targetKeyboard(config, selected),
      );
      return true;
    }
    const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
    if (!text) {
      await replyVideoPrompt(ctx, "⌨ Сейчас жду текстовый ответ. Нажмите «☰ Показать меню», чтобы начать другой сценарий.");
      return true;
    }
    if (!session.draftId) return false;
    if (session.step.startsWith("youtube_")) return handleYouTubeMessage(ctx, backendDb, adminId, session, text);
    if (session.step === "label") {
      updateVideoLabel(backendDb, session.draftId, text);
      if (session.data.is_single_edit) {
        clearSession(backendDb, adminId);
        const preview = videoPreview(backendDb, session.draftId);
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
        "Выберите платформы, затем нажмите «Далее».",
        targetKeyboard(config, session.selected),
      );
      return true;
    }
    if (session.step === "instagram_caption") {
      if (session.data.is_single_edit) {
        await finishSingleVideoEdit(ctx, backendDb, adminId, session, "instagram_reels", (metadata) => {
          metadata.caption = text === "-" ? "" : text;
          delete metadata.hashtags;
        });
        return true;
      }
      const metadata = { caption: text === "-" ? "" : text };
      saveVideoMetadata(backendDb, session.draftId, "instagram_reels", metadata);
      if (!session.selected.includes("youtube_shorts")) updateVideoLabel(backendDb, session.draftId, metadata.caption || "Instagram Reels");
      await askSchedule(ctx, backendDb, adminId, session);
      return true;
    }
    if (session.step === "schedule_common" || session.step.startsWith("schedule_target:"))
      return handleScheduleMessage(ctx, backendDb, config, adminId, session, text);
  } catch (error) {
    await replyVideoPrompt(ctx, `🔴 Не получилось: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
  return false;
}

async function handleYouTubeMessage(
  ctx: Context,
  backendDb: BackendDb,
  adminId: number,
  session: VideoSession,
  text: string,
): Promise<boolean> {
  if (session.draftId == null) return false;
  if (session.step === "youtube_title") {
    if (session.data.is_single_edit) {
      await finishSingleVideoEdit(ctx, backendDb, adminId, session, "youtube_shorts", (metadata, draftId) => {
        metadata.title = text;
        updateVideoLabel(backendDb, draftId, text || "YouTube Shorts");
      });
      return true;
    }
    setData(backendDb, adminId, session, "youtube_title", text, "youtube_description");
    await replyVideoPrompt(ctx, "⌨ Описание для YouTube (отправьте «-», если не нужно):");
    return true;
  }
  if (session.step === "youtube_description") {
    if (session.data.is_single_edit) {
      await finishSingleVideoEdit(ctx, backendDb, adminId, session, "youtube_shorts", (metadata) => {
        metadata.description = text === "-" ? "" : text;
      });
      return true;
    }
    setData(backendDb, adminId, session, "youtube_description", text === "-" ? "" : text, "youtube_game_url");
    await ctx.reply("📀 Ссылка на Steam или страницу игры?", {
      reply_markup: new InlineKeyboard().text("⏭ Пропустить", "video_game_skip"),
    });
    return true;
  }
  if (session.step === "youtube_game_url") {
    if (session.data.is_single_edit) {
      await finishSingleVideoEdit(ctx, backendDb, adminId, session, "youtube_shorts", (metadata) => {
        metadata.gameUrl = text === "-" ? undefined : text;
      });
      return true;
    }
    setData(backendDb, adminId, session, "youtube_game_url", text === "-" ? "" : text, "youtube_tags");
    await replyVideoPrompt(ctx, "⌨ Теги YouTube через запятую (или «-»):");
    return true;
  }
  if (session.step !== "youtube_tags") return false;
  const tags =
    text === "-"
      ? []
      : text
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
  if (session.data.is_single_edit) {
    await finishSingleVideoEdit(ctx, backendDb, adminId, session, "youtube_shorts", (metadata) => {
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
  saveVideoMetadata(backendDb, session.draftId, "youtube_shorts", metadata);
  updateVideoLabel(backendDb, session.draftId, metadata.title || "YouTube Shorts");
  await askInstagramOrSchedule(ctx, backendDb, adminId, session);
  return true;
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
    const date = parseManualSchedule(text);
    await finishVideoSchedule(
      ctx,
      backendDb,
      config,
      adminId,
      session,
      Object.fromEntries(session.selected.map((target) => [target, date])) as Partial<Record<VideoTarget, Date>>,
    );
    return true;
  }
  const target = session.step.slice("schedule_target:".length) as VideoTarget;
  const schedule = {
    ...(session.data.schedule as Record<string, string> | undefined),
    [target]: parseManualSchedule(text).toISOString(),
  };
  const remaining = session.selected.find((item) => !schedule[item]);
  if (remaining) {
    saveSession(backendDb, adminId, { ...session, step: `schedule_target:${remaining}`, data: { ...session.data, schedule } });
    await replyVideoPrompt(ctx, `⌨ Когда опубликовать на ${videoTargetLabel(remaining)}? Формат: 15.07 18:30 (МСК).`);
    return true;
  }
  await finishVideoSchedule(
    ctx,
    backendDb,
    config,
    adminId,
    session,
    Object.fromEntries(Object.entries(schedule).map(([key, value]) => [key, new Date(value)])) as Partial<Record<VideoTarget, Date>>,
  );
  return true;
}

async function finishSingleVideoEdit(
  ctx: Context,
  backendDb: BackendDb,
  adminId: number,
  session: VideoSession,
  target: VideoTarget,
  change: (metadata: Record<string, unknown>, draftId: number) => void,
): Promise<void> {
  if (session.draftId == null) throw new Error("Откройте редактирование видео заново.");
  const row = backendDb.db
    .select({ metadataJson: videoTargets.metadataJson })
    .from(videoTargets)
    .where(and(eq(videoTargets.videoDraftId, session.draftId), eq(videoTargets.target, target)))
    .get();
  const metadata = { ...(row?.metadataJson as Record<string, unknown> | undefined) };
  change(metadata, session.draftId);
  saveVideoMetadata(backendDb, session.draftId, target, metadata as Parameters<typeof saveVideoMetadata>[3]);
  clearSession(backendDb, adminId);
  const preview = videoPreview(backendDb, session.draftId);
  await updateVideoControl(ctx, session, preview.text, preview.keyboard);
}

export async function handleVideoCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("video_")) return false;
  const adminId = Number(ctx.from?.id);
  try {
    if (data === "video_start") await startVideoFlow(ctx, backendDb);
    else if (data === "video_cancel_dialog") {
      clearSession(backendDb, adminId);
      await ctx.answerCallbackQuery();
      try {
        await ctx.deleteMessage();
      } catch {}
      const keyboard = new InlineKeyboard();
      if (config.studio.modules.text_posting) keyboard.text("📝 Новый пост", "menu_text");
      if (config.studio.modules.video_posting) keyboard.text("🎬 Новое видео", "video_start");
      keyboard.row();
      keyboard.text("📋 Очередь", "queue_home");
      if (config.studio.modules.analytics) keyboard.text("📊 Статистика", "analytics_home");
      await ctx.reply("Панель управления:", { reply_markup: keyboard });
      return true;
    } else if (data.startsWith("video_toggle:")) {
      const target = data.slice("video_toggle:".length) as VideoTarget;
      const session = getSession(backendDb, adminId);
      if (!session || !VIDEO_TARGETS.includes(target)) throw new Error("Начните создание видео заново.");
      const selected = session.selected.includes(target)
        ? session.selected.filter((item) => item !== target)
        : [...session.selected, target];
      saveSession(backendDb, adminId, { ...session, selected });
      await ctx.editMessageReplyMarkup({ reply_markup: targetKeyboard(config, selected) });
    } else if (data === "video_targets_done") {
      const session = getSession(backendDb, adminId);
      if (!session?.draftId || !session.selected.length) throw new Error("Выберите хотя бы одну платформу.");
      replaceVideoTargets(backendDb, session.draftId, session.selected);
      if (session.selected.includes("youtube_shorts")) {
        const next = { ...session, step: "youtube_title" };
        saveSession(backendDb, adminId, next);
        await replyVideoPrompt(ctx, "⌨ Название для YouTube Shorts:");
      } else await askInstagramOrSchedule(ctx, backendDb, adminId, session);
    } else if (data === "video_game_skip") {
      const session = getSession(backendDb, adminId);
      if (!session?.draftId || session.step !== "youtube_game_url") throw new Error("Откройте создание видео заново.");
      setData(backendDb, adminId, session, "youtube_game_url", "", "youtube_tags");
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("📀 Ссылка на игру пропущена.");
      await replyVideoPrompt(ctx, "⌨ Теги YouTube через запятую (или «-»):");
      return true;
    } else if (data.startsWith("video_open:")) {
      const id = Number(data.slice("video_open:".length));
      const preview = videoPreview(backendDb, id);
      const messageId = callbackMessageId(ctx);
      if (messageId && ctx.chat?.id) setVideoControlCard(backendDb, id, Number(ctx.chat.id), messageId);
      await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
    } else if (data.startsWith("video_retry:")) {
      const [, target, idText] = data.split(":");
      const targetName = target as VideoTarget;
      const id = Number(idText);
      if (!VIDEO_TARGETS.includes(targetName)) throw new Error("Неизвестная площадка.");
      retryFailedVideoTarget(backendDb, id, targetName);
      const preview = videoPreview(backendDb, id);
      await ctx.answerCallbackQuery({ text: `${videoTargetLabel(targetName)} снова поставлен в очередь` });
      await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
      return true;
    } else if (await handleScheduleCallback(ctx, backendDb, adminId, data)) {
    } else if (data.startsWith("video_now:")) {
      const id = Number(data.slice("video_now:".length));
      const preview = videoPreview(backendDb, id);
      await ctx.editMessageText(`${preview.text}\n\n⚠️ *Опубликовать сейчас?* Видео будет поставлено в очередь на ближайшую минуту.`, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("✅ Да, опубликовать", `video_now_confirm:${id}`).text("← Назад", `video_open:${id}`),
      });
    } else if (data.startsWith("video_now_confirm:")) {
      const id = Number(data.slice("video_now_confirm:".length));
      const targets = listVideoTargets(backendDb, id).map((row) => row.target as VideoTarget);
      await finishVideoSchedule(
        ctx,
        backendDb,
        config,
        adminId,
        { draftId: id, step: "", selected: targets, data: { controlMessageId: callbackMessageId(ctx) } },
        Object.fromEntries(targets.map((target) => [target, new Date(Date.now() + 60_000)])),
      );
    } else if (data.startsWith("video_cancel:")) {
      cancelVideo(backendDb, Number(data.slice("video_cancel:".length)), config.VIDEO_MEDIA_RETENTION_HOURS);
      clearSession(backendDb, adminId);
      await ctx.editMessageText(`🗑 Видеопубликация отменена. Исходник останется на сервере ещё ${config.VIDEO_MEDIA_RETENTION_HOURS} ч.`);
    } else if (data.startsWith("video_time:")) {
      const parts = data.split(":");
      const target = parts[1] as VideoTarget;
      const id = Number(parts[2]);
      const session = {
        draftId: id,
        step: `schedule_target:${target}`,
        selected: [target],
        data: { controlMessageId: callbackMessageId(ctx) },
      };
      saveSession(backendDb, adminId, session);
      setControlFromSession(backendDb, id, ctx, session);
      await replyVideoPrompt(ctx, `⌨ Когда опубликовать на ${videoTargetLabel(target)}? Формат: 15.07 18:30 (МСК).`);
    } else if (data.startsWith("video_remove:")) {
      const parts = data.split(":");
      const target = parts[1] as VideoTarget;
      const id = Number(parts[2]);
      const targetRow = backendDb.db
        .select()
        .from(videoTargets)
        .where(and(eq(videoTargets.videoDraftId, id), eq(videoTargets.target, target)))
        .get();
      if (targetRow) {
        backendDb.db
          .delete(videoJobs)
          .where(and(eq(videoJobs.videoDraftId, id), eq(videoJobs.videoTargetId, targetRow.id)))
          .run();
        backendDb.db.delete(videoTargets).where(eq(videoTargets.id, targetRow.id)).run();
      }
      refreshVideoDraftStatus(backendDb, id, config.VIDEO_MEDIA_RETENTION_HOURS);
      const remainingTargets = listVideoTargets(backendDb, id);
      if (remainingTargets.length === 0) {
        cancelVideo(backendDb, id, config.VIDEO_MEDIA_RETENTION_HOURS);
        clearSession(backendDb, adminId);
        await ctx.editMessageText("🗑 Все платформы удалены. Публикация отменена.");
      } else {
        await ctx.answerCallbackQuery({ text: `${videoTargetLabel(target)} removed` });
        const preview = videoPreview(backendDb, id);
        await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
      }
      return true;
    } else if (await handleEditMenuCallback(ctx, backendDb, adminId, data)) {
      return true;
    } else if (data.startsWith("video_edit:")) {
      const id = Number(data.slice("video_edit:".length));
      const session = {
        draftId: id,
        step: "label",
        selected: listVideoTargets(backendDb, id).map((row) => row.target as VideoTarget),
        data: { controlMessageId: callbackMessageId(ctx) },
      };
      saveSession(backendDb, adminId, session);
      setControlFromSession(backendDb, id, ctx, session);
      await replyVideoPrompt(ctx, "⌨ Введите новую внутреннюю подпись видео:");
    }
    await ctx.answerCallbackQuery();
  } catch (error) {
    await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Ошибка" });
  }
  return true;
}

async function handleScheduleCallback(ctx: Context, backendDb: BackendDb, adminId: number, data: string): Promise<boolean> {
  if (data.startsWith("video_schedule:")) {
    const id = Number(data.slice("video_schedule:".length));
    const targets = listVideoTargets(backendDb, id).map((row) => row.target as VideoTarget);
    if (!targets.length) throw new Error("У видео не выбраны платформы.");
    const keyboard = new InlineKeyboard().text("Одно время для всех", `video_common:${id}`);
    if (targets.length > 1) keyboard.row().text("Разное время", `video_individual:${id}`);
    const session = { draftId: id, step: "schedule_choice", selected: targets, data: { controlMessageId: callbackMessageId(ctx) } };
    saveSession(backendDb, adminId, session);
    setControlFromSession(backendDb, id, ctx, session);
    await updateVideoControl(ctx, session, "📅 Время публикации (МСК):", keyboard);
    return true;
  }
  if (!data.startsWith("video_common:") && !data.startsWith("video_individual:")) return false;
  const id = Number(data.split(":")[1]);
  const session = getSession(backendDb, adminId);
  const targets = listVideoTargets(backendDb, id).map((row) => row.target as VideoTarget);
  if (!session || !targets.length) throw new Error("Откройте публикацию ещё раз.");
  if (data.startsWith("video_common:")) {
    saveSession(backendDb, adminId, { ...session, draftId: id, selected: targets, step: "schedule_common" });
    await replyVideoPrompt(ctx, "⌨ Введите дату и время, например: 15.07 18:30 (МСК).");
    return true;
  }
  const first = targets[0];
  if (!first) throw new Error("У видео не выбраны платформы.");
  saveSession(backendDb, adminId, {
    ...session,
    draftId: id,
    selected: targets,
    step: `schedule_target:${first}`,
    data: { ...session.data, schedule: {} },
  });
  await replyVideoPrompt(ctx, `⌨ Когда опубликовать на ${videoTargetLabel(first)}? Формат: 15.07 18:30 (МСК).`);
  return true;
}

async function handleEditMenuCallback(ctx: Context, backendDb: BackendDb, adminId: number, data: string): Promise<boolean> {
  if (data.startsWith("video_edit_menu:")) {
    const id = Number(data.slice("video_edit_menu:".length));
    const targets = listVideoTargets(backendDb, id).map((target) => target.target as VideoTarget);
    const keyboard = new InlineKeyboard().text("✏️ Изменить имя карточки", `video_edit_field:label:${id}`).row();
    if (targets.includes("youtube_shorts")) {
      keyboard.text("✏️ Название YouTube", `video_edit_field:youtube_title:${id}`).row();
      keyboard.text("✏️ Описание YouTube", `video_edit_field:youtube_description:${id}`).row();
      keyboard.text("📀 Ссылка на игру", `video_edit_field:youtube_game_url:${id}`).row();
      keyboard.text("✏️ Теги YouTube", `video_edit_field:youtube_tags:${id}`).row();
    }
    if (targets.includes("instagram_reels")) keyboard.text("✏️ Подпись Instagram", `video_edit_field:instagram_caption:${id}`).row();
    keyboard.text("← Назад", `video_open:${id}`);
    await ctx.editMessageText("✏️ *Что изменить?*", { parse_mode: "Markdown", reply_markup: keyboard });
    return true;
  }
  if (!data.startsWith("video_edit_field:")) return false;
  const [, field = "", idText] = data.split(":");
  const id = Number(idText);
  const session = {
    draftId: id,
    step: field,
    selected: listVideoTargets(backendDb, id).map((target) => target.target as VideoTarget),
    data: { controlMessageId: callbackMessageId(ctx), is_single_edit: true },
  };
  saveSession(backendDb, adminId, session);
  setControlFromSession(backendDb, id, ctx, session);
  const prompts: Record<string, string> = {
    label: "⌨ Введите новую внутреннюю подпись видео:",
    youtube_title: "⌨ Введите новое название для YouTube Shorts:",
    youtube_description: "⌨ Введите новое описание для YouTube (или «-»):",
    youtube_game_url: "📀 Введите ссылку на Steam/страницу игры (или «-»):",
    youtube_tags: "⌨ Введите новые теги YouTube через запятую (или «-»):",
    instagram_caption: "⌨ Введите подпись для Instagram Reels — вместе с хэштегами (или «-»):",
  };
  await replyVideoPrompt(ctx, prompts[field] ?? "⌨ Введите новое значение:");
  return true;
}
