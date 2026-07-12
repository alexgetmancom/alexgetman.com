import { and, eq } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { videoBotSessions, videoJobs, videoTargets } from "../db/schema.js";
import { parseManualSchedule } from "../publishingSchedule.js";
import {
  cancelVideo,
  createVideoDraft,
  listVideoTargets,
  refreshVideoDraftStatus,
  replaceVideoTargets,
  saveVideoMetadata,
  scheduleVideo,
  setVideoControlCard,
  updateVideoLabel,
  validateVideoDraft,
  videoPreview,
} from "../video/service.js";
import { storeTelegramVideo } from "../video/storage.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../video/types.js";

type Session = { draftId: number | null; step: string; selected: VideoTarget[]; data: Record<string, unknown> };

export async function startVideoFlow(ctx: Context, backendDb: BackendDb): Promise<void> {
  const adminId = Number(ctx.from?.id);
  const messageId = callbackMessageId(ctx);
  const cancelMarkup = new InlineKeyboard().text("← Cancel", "video_cancel_dialog");
  if (messageId)
    await ctx.editMessageText("🎬 Пришлите видео MP4. Затем я попрошу подпись, платформы и параметры публикации.", {
      reply_markup: cancelMarkup,
    });
  else {
    const message = await ctx.reply("🎬 Пришлите видео MP4. Затем я попрошу подпись, платформы и параметры публикации.", {
      reply_markup: cancelMarkup,
    });
    saveSession(backendDb, adminId, { draftId: null, step: "asset", selected: [], data: { controlMessageId: message.message_id } });
    return;
  }
  saveSession(backendDb, adminId, { draftId: null, step: "asset", selected: [], data: { controlMessageId: messageId } });
}

export async function handleVideoMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  if (!config.studio.modules.video_posting) return false;
  const adminId = Number(ctx.from?.id);
  const session = getSession(backendDb, adminId);
  if (!session) return false;
  try {
    if (session.step === "asset") {
      const stored = await storeTelegramVideo(ctx, config);
      const draftId = createVideoDraft(backendDb, adminId, stored.assetKey);
      const next = { ...session, draftId, step: "label" };
      saveSession(backendDb, adminId, next);
      setControlFromSession(backendDb, draftId, ctx, next);
      await updateVideoControl(ctx, next, "✏️ Как кратко назвать это видео? Например: «Hades, часть 3». Это внутренняя подпись.");
      return true;
    }
    const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
    if (!text) {
      await updateVideoControl(ctx, session, "⌨ Сейчас жду текстовый ответ. Нажмите «☰ Показать меню», чтобы начать другой сценарий.");
      return true;
    }
    if (!session.draftId) return false;
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
      await updateVideoControl(ctx, next, "Выберите платформы, затем нажмите «Далее».", targetKeyboard(config, []));
      return true;
    }
    if (session.step === "youtube_title") {
      if (session.data.is_single_edit) {
        const target = backendDb.db
          .select()
          .from(videoTargets)
          .where(and(eq(videoTargets.videoDraftId, session.draftId), eq(videoTargets.target, "youtube_shorts")))
          .get();
        const metadata = (target?.metadataJson as any) || {};
        metadata.title = text;
        saveVideoMetadata(backendDb, session.draftId, "youtube_shorts", metadata);
        clearSession(backendDb, adminId);
        const preview = videoPreview(backendDb, session.draftId);
        await updateVideoControl(ctx, session, preview.text, preview.keyboard);
        return true;
      }
      const next = setData(backendDb, adminId, session, "youtube_title", text, "youtube_description");
      await updateVideoControl(ctx, next, "⌨ Описание для YouTube (отправьте «-», если не нужно):");
      return true;
    }
    if (session.step === "youtube_description") {
      if (session.data.is_single_edit) {
        const target = backendDb.db
          .select()
          .from(videoTargets)
          .where(and(eq(videoTargets.videoDraftId, session.draftId), eq(videoTargets.target, "youtube_shorts")))
          .get();
        const metadata = (target?.metadataJson as any) || {};
        metadata.description = text === "-" ? "" : text;
        saveVideoMetadata(backendDb, session.draftId, "youtube_shorts", metadata);
        clearSession(backendDb, adminId);
        const preview = videoPreview(backendDb, session.draftId);
        await updateVideoControl(ctx, session, preview.text, preview.keyboard);
        return true;
      }
      const next = setData(backendDb, adminId, session, "youtube_description", text === "-" ? "" : text, "youtube_tags");
      await updateVideoControl(ctx, next, "⌨ Теги YouTube через запятую (или «-»):");
      return true;
    }
    if (session.step === "youtube_tags") {
      const tags =
        text === "-"
          ? []
          : text
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean);
      if (session.data.is_single_edit) {
        const target = backendDb.db
          .select()
          .from(videoTargets)
          .where(and(eq(videoTargets.videoDraftId, session.draftId), eq(videoTargets.target, "youtube_shorts")))
          .get();
        const metadata = (target?.metadataJson as any) || {};
        metadata.tags = tags;
        saveVideoMetadata(backendDb, session.draftId, "youtube_shorts", metadata);
        clearSession(backendDb, adminId);
        const preview = videoPreview(backendDb, session.draftId);
        await updateVideoControl(ctx, session, preview.text, preview.keyboard);
        return true;
      }
      const metadata = {
        title: String(session.data.youtube_title ?? ""),
        description: String(session.data.youtube_description ?? ""),
        tags,
      };
      saveVideoMetadata(backendDb, session.draftId, "youtube_shorts", metadata);
      await askInstagramOrSchedule(ctx, backendDb, adminId, session);
      return true;
    }
    if (session.step === "instagram_caption") {
      if (session.data.is_single_edit) {
        const target = backendDb.db
          .select()
          .from(videoTargets)
          .where(and(eq(videoTargets.videoDraftId, session.draftId), eq(videoTargets.target, "instagram_reels")))
          .get();
        const metadata = (target?.metadataJson as any) || {};
        metadata.caption = text === "-" ? "" : text;
        saveVideoMetadata(backendDb, session.draftId, "instagram_reels", metadata);
        clearSession(backendDb, adminId);
        const preview = videoPreview(backendDb, session.draftId);
        await updateVideoControl(ctx, session, preview.text, preview.keyboard);
        return true;
      }
      const next = setData(backendDb, adminId, session, "instagram_caption", text === "-" ? "" : text, "instagram_hashtags");
      await updateVideoControl(ctx, next, "⌨ Хэштеги Instagram через пробел или запятую (или «-»):");
      return true;
    }
    if (session.step === "instagram_hashtags") {
      const hashtags =
        text === "-"
          ? []
          : text
              .split(/[\s,]+/)
              .map((tag) => tag.trim())
              .filter(Boolean)
              .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
      if (session.data.is_single_edit) {
        const target = backendDb.db
          .select()
          .from(videoTargets)
          .where(and(eq(videoTargets.videoDraftId, session.draftId), eq(videoTargets.target, "instagram_reels")))
          .get();
        const metadata = (target?.metadataJson as any) || {};
        metadata.hashtags = hashtags;
        saveVideoMetadata(backendDb, session.draftId, "instagram_reels", metadata);
        clearSession(backendDb, adminId);
        const preview = videoPreview(backendDb, session.draftId);
        await updateVideoControl(ctx, session, preview.text, preview.keyboard);
        return true;
      }
      const metadata = {
        caption: String(session.data.instagram_caption ?? ""),
        hashtags,
      };
      saveVideoMetadata(backendDb, session.draftId, "instagram_reels", metadata);
      await askSchedule(ctx, backendDb, adminId, session);
      return true;
    }
    if (session.step === "schedule_common") {
      const date = parseManualSchedule(text);
      await finishSchedule(
        ctx,
        backendDb,
        config,
        adminId,
        session,
        Object.fromEntries(session.selected.map((target) => [target, date])) as Partial<Record<VideoTarget, Date>>,
      );
      return true;
    }
    if (session.step.startsWith("schedule_target:")) {
      const target = session.step.slice("schedule_target:".length) as VideoTarget;
      const schedule = {
        ...(session.data.schedule as Record<string, string> | undefined),
        [target]: parseManualSchedule(text).toISOString(),
      };
      const remaining = session.selected.find((item) => !schedule[item]);
      if (remaining) {
        saveSession(backendDb, adminId, { ...session, step: `schedule_target:${remaining}`, data: { ...session.data, schedule } });
        await updateVideoControl(
          ctx,
          { ...session, step: `schedule_target:${remaining}`, data: { ...session.data, schedule } },
          `⌨ Когда опубликовать на ${videoTargetLabel(remaining)}? Формат: 15.07 18:30 (МСК).`,
        );
      } else {
        await finishSchedule(
          ctx,
          backendDb,
          config,
          adminId,
          session,
          Object.fromEntries(Object.entries(schedule).map(([key, value]) => [key, new Date(value)])) as Partial<Record<VideoTarget, Date>>,
        );
      }
      return true;
    }
  } catch (error) {
    await updateVideoControl(ctx, session, `🔴 Не получилось: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
  return false;
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
      } catch (err) {}
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
        await updateVideoControl(ctx, next, "⌨ Название для YouTube Shorts:");
      } else await askInstagramOrSchedule(ctx, backendDb, adminId, session);
    } else if (data.startsWith("video_open:")) {
      const id = Number(data.slice("video_open:".length));
      const preview = videoPreview(backendDb, id);
      const messageId = callbackMessageId(ctx);
      if (messageId && ctx.chat?.id) setVideoControlCard(backendDb, id, Number(ctx.chat.id), messageId);
      await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
    } else if (data.startsWith("video_schedule:")) {
      const id = Number(data.slice("video_schedule:".length));
      const targets = listVideoTargets(backendDb, id).map((row) => row.target as VideoTarget);
      if (!targets.length) throw new Error("У видео не выбраны платформы.");
      const keyboard = new InlineKeyboard().text("Одно время для всех", `video_common:${id}`);
      if (targets.length > 1) keyboard.row().text("Разное время", `video_individual:${id}`);
      const session = { draftId: id, step: "schedule_choice", selected: targets, data: { controlMessageId: callbackMessageId(ctx) } };
      saveSession(backendDb, adminId, session);
      setControlFromSession(backendDb, id, ctx, session);
      await updateVideoControl(ctx, session, "📅 Время публикации (МСК):", keyboard);
    } else if (data.startsWith("video_common:") || data.startsWith("video_individual:")) {
      const id = Number(data.split(":")[1]);
      const session = getSession(backendDb, adminId);
      const targets = listVideoTargets(backendDb, id).map((row) => row.target as VideoTarget);
      if (!session || !targets.length) throw new Error("Откройте публикацию ещё раз.");
      if (data.startsWith("video_common:")) {
        saveSession(backendDb, adminId, { ...session, draftId: id, selected: targets, step: "schedule_common" });
        await updateVideoControl(
          ctx,
          { ...session, draftId: id, selected: targets, step: "schedule_common" },
          "⌨ Введите дату и время, например: 15.07 18:30 (МСК).",
        );
      } else {
        const first = targets[0];
        if (!first) throw new Error("У видео не выбраны платформы.");
        saveSession(backendDb, adminId, {
          ...session,
          draftId: id,
          selected: targets,
          step: `schedule_target:${first}`,
          data: { ...session.data, schedule: {} },
        });
        await updateVideoControl(
          ctx,
          { ...session, draftId: id, selected: targets, step: `schedule_target:${first}`, data: { ...session.data, schedule: {} } },
          `⌨ Когда опубликовать на ${videoTargetLabel(first)}? Формат: 15.07 18:30 (МСК).`,
        );
      }
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
      await finishSchedule(
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
      await updateVideoControl(ctx, session, `⌨ Когда опубликовать на ${videoTargetLabel(target)}? Формат: 15.07 18:30 (МСК).`);
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
    } else if (data.startsWith("video_edit_menu:")) {
      const id = Number(data.slice("video_edit_menu:".length));
      const targets = listVideoTargets(backendDb, id).map((t) => t.target as VideoTarget);
      const keyboard = new InlineKeyboard();
      keyboard.text("✏️ Edit label", `video_edit_field:label:${id}`).row();
      if (targets.includes("youtube_shorts")) {
        keyboard.text("✏️ YouTube Title", `video_edit_field:youtube_title:${id}`).row();
        keyboard.text("✏️ YouTube Desc", `video_edit_field:youtube_description:${id}`).row();
        keyboard.text("✏️ YouTube Tags", `video_edit_field:youtube_tags:${id}`).row();
      }
      if (targets.includes("instagram_reels")) {
        keyboard.text("✏️ Instagram Caption", `video_edit_field:instagram_caption:${id}`).row();
        keyboard.text("✏️ Instagram Tags", `video_edit_field:instagram_hashtags:${id}`).row();
      }
      keyboard.text("← Back", `video_open:${id}`);
      await ctx.editMessageText("✏️ *Select field to edit:*", { parse_mode: "Markdown", reply_markup: keyboard });
      return true;
    } else if (data.startsWith("video_edit_field:")) {
      const parts = data.split(":");
      const field = parts[1];
      const id = Number(parts[2]);
      const session = {
        draftId: id,
        step: field || "",
        selected: listVideoTargets(backendDb, id).map((t) => t.target as VideoTarget),
        data: { controlMessageId: callbackMessageId(ctx), is_single_edit: true },
      };
      saveSession(backendDb, adminId, session);
      setControlFromSession(backendDb, id, ctx, session);
      let prompt = "⌨ Введите новое значение:";
      if (field === "label") prompt = "⌨ Введите новую внутреннюю подпись видео:";
      else if (field === "youtube_title") prompt = "⌨ Введите новое название для YouTube Shorts:";
      else if (field === "youtube_description") prompt = "⌨ Введите новое описание для YouTube (или «-»):";
      else if (field === "youtube_tags") prompt = "⌨ Введите новые теги YouTube через запятую (или «-»):";
      else if (field === "instagram_caption") prompt = "⌨ Введите новое описание для Instagram Reels (или «-»):";
      else if (field === "instagram_hashtags") prompt = "⌨ Введите новые хэштеги Instagram через пробел (или «-»):";
      await updateVideoControl(ctx, session, prompt);
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
      await updateVideoControl(ctx, session, "⌨ Введите новую внутреннюю подпись видео:");
    }
    await ctx.answerCallbackQuery();
  } catch (error) {
    await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Ошибка" });
  }
  return true;
}

async function askInstagramOrSchedule(ctx: Context, backendDb: BackendDb, adminId: number, session: Session): Promise<void> {
  if (session.selected.includes("instagram_reels")) {
    const next = { ...session, step: "instagram_caption" };
    saveSession(backendDb, adminId, next);
    await updateVideoControl(ctx, next, "⌨ Описание для Instagram Reels (или «-»):");
  } else await askSchedule(ctx, backendDb, adminId, session);
}

async function askSchedule(ctx: Context, backendDb: BackendDb, adminId: number, session: Session): Promise<void> {
  saveSession(backendDb, adminId, { ...session, step: "schedule_choice" });
  const keyboard = new InlineKeyboard().text("Одно время для всех", `video_common:${session.draftId}`);
  if (session.selected.length > 1) keyboard.row().text("Разное время", `video_individual:${session.draftId}`);
  keyboard.row().text("← Cancel", "video_cancel_dialog");
  await updateVideoControl(ctx, { ...session, step: "schedule_choice" }, "Данные сохранены. Выберите расписание (МСК):", keyboard);
}

async function finishSchedule(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  session: Session,
  schedule: Partial<Record<VideoTarget, Date>>,
): Promise<void> {
  if (!session.draftId) throw new Error("Черновик не найден.");
  validateVideoDraft(config, backendDb, session.draftId);
  const targets = listVideoTargets(backendDb, session.draftId);
  const fullSchedule: Partial<Record<VideoTarget, Date>> = { ...schedule };
  for (const t of targets) {
    if (!fullSchedule[t.target as VideoTarget]) {
      if (t.scheduledAt) {
        fullSchedule[t.target as VideoTarget] = new Date(t.scheduledAt);
      } else {
        fullSchedule[t.target as VideoTarget] = new Date(Date.now() + 60_000);
      }
    }
  }
  scheduleVideo(backendDb, session.draftId, fullSchedule, {
    prepareLeadMinutes: config.VIDEO_PREPARE_LEAD_MINUTES,
    reminderMinutes: config.VIDEO_REMINDER_MINUTES,
  });
  clearSession(backendDb, adminId);
  const preview = videoPreview(backendDb, session.draftId);
  setControlFromSession(backendDb, session.draftId, ctx, session);
  await updateVideoControl(
    ctx,
    session,
    `✅ Запланировано. Напомню за ${config.VIDEO_REMINDER_MINUTES} минут.\n\n${preview.text}`,
    preview.keyboard,
  );
}

function targetKeyboard(config: BackendConfig, selected: VideoTarget[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const target of VIDEO_TARGETS) {
    if (target === "youtube_shorts" && !config.studio.modules.youtube) continue;
    if (target === "instagram_reels" && !config.studio.modules.instagram) continue;
    keyboard.text(`${selected.includes(target) ? "✓" : "○"} ${videoTargetLabel(target)}`, `video_toggle:${target}`).row();
  }
  keyboard.text("Далее", "video_targets_done").row();
  keyboard.text("← Cancel", "video_cancel_dialog");
  return keyboard;
}

function getSession(backendDb: BackendDb, adminId: number): Session | null {
  const row = backendDb.db.select().from(videoBotSessions).where(eq(videoBotSessions.adminId, adminId)).get();
  return row
    ? { draftId: row.videoDraftId, step: row.step, selected: row.selectedTargetsJson as VideoTarget[], data: row.dataJson ?? {} }
    : null;
}

function saveSession(backendDb: BackendDb, adminId: number, session: Session): void {
  const now = new Date().toISOString();
  backendDb.db
    .insert(videoBotSessions)
    .values({
      adminId,
      videoDraftId: session.draftId,
      step: session.step,
      selectedTargetsJson: session.selected,
      dataJson: session.data,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: videoBotSessions.adminId,
      set: {
        videoDraftId: session.draftId,
        step: session.step,
        selectedTargetsJson: session.selected,
        dataJson: session.data,
        updatedAt: now,
      },
    })
    .run();
}

function setData(backendDb: BackendDb, adminId: number, session: Session, key: string, value: unknown, nextStep: string): Session {
  const next = { ...session, step: nextStep, data: { ...session.data, [key]: value } };
  saveSession(backendDb, adminId, next);
  return next;
}

function clearSession(backendDb: BackendDb, adminId: number): void {
  backendDb.db.delete(videoBotSessions).where(eq(videoBotSessions.adminId, adminId)).run();
}

async function updateVideoControl(ctx: Context, session: Session, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const messageId = Number(session.data.controlMessageId);
  const replyMarkup = keyboard ?? new InlineKeyboard().text("← Cancel", "video_cancel_dialog");
  if (messageId && ctx.chat?.id) {
    await ctx.api.editMessageText(ctx.chat.id, messageId, text, {
      parse_mode: "Markdown",
      reply_markup: replyMarkup,
    });
    return;
  }
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: replyMarkup });
}

function setControlFromSession(backendDb: BackendDb, draftId: number, ctx: Context, session: Session): void {
  const messageId = Number(session.data.controlMessageId);
  if (messageId && ctx.chat?.id) setVideoControlCard(backendDb, draftId, Number(ctx.chat.id), messageId);
}

function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}
