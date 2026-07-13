import { and, eq } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { videoJobs, videoTargets } from "../db/schema.js";
import { parseManualSchedule } from "../publishingSchedule.js";
import {
  cancelVideo,
  createVideoDraft,
  listVideoTargets,
  refreshVideoDraftStatus,
  replaceVideoTargets,
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
        updateVideoLabel(backendDb, session.draftId, text || "YouTube Shorts");
        clearSession(backendDb, adminId);
        const preview = videoPreview(backendDb, session.draftId);
        await updateVideoControl(ctx, session, preview.text, preview.keyboard);
        return true;
      }
      setData(backendDb, adminId, session, "youtube_title", text, "youtube_description");
      await replyVideoPrompt(ctx, "⌨ Описание для YouTube (отправьте «-», если не нужно):");
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
      setData(backendDb, adminId, session, "youtube_description", text === "-" ? "" : text, "youtube_tags");
      await replyVideoPrompt(ctx, "⌨ Теги YouTube через запятую (или «-»):");
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
      updateVideoLabel(backendDb, session.draftId, metadata.title || "YouTube Shorts");
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
        delete metadata.hashtags;
        saveVideoMetadata(backendDb, session.draftId, "instagram_reels", metadata);
        clearSession(backendDb, adminId);
        const preview = videoPreview(backendDb, session.draftId);
        await updateVideoControl(ctx, session, preview.text, preview.keyboard);
        return true;
      }
      const metadata = { caption: text === "-" ? "" : text };
      saveVideoMetadata(backendDb, session.draftId, "instagram_reels", metadata);
      if (!session.selected.includes("youtube_shorts")) updateVideoLabel(backendDb, session.draftId, metadata.caption || "Instagram Reels");
      await askSchedule(ctx, backendDb, adminId, session);
      return true;
    }
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
    if (session.step.startsWith("schedule_target:")) {
      const target = session.step.slice("schedule_target:".length) as VideoTarget;
      const schedule = {
        ...(session.data.schedule as Record<string, string> | undefined),
        [target]: parseManualSchedule(text).toISOString(),
      };
      const remaining = session.selected.find((item) => !schedule[item]);
      if (remaining) {
        saveSession(backendDb, adminId, { ...session, step: `schedule_target:${remaining}`, data: { ...session.data, schedule } });
        await replyVideoPrompt(ctx, `⌨ Когда опубликовать на ${videoTargetLabel(remaining)}? Формат: 15.07 18:30 (МСК).`);
      } else {
        await finishVideoSchedule(
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
    await replyVideoPrompt(ctx, `🔴 Не получилось: ${error instanceof Error ? error.message : String(error)}`);
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
        await replyVideoPrompt(ctx, "⌨ Введите дату и время, например: 15.07 18:30 (МСК).");
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
        await replyVideoPrompt(ctx, `⌨ Когда опубликовать на ${videoTargetLabel(first)}? Формат: 15.07 18:30 (МСК).`);
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
    } else if (data.startsWith("video_edit_menu:")) {
      const id = Number(data.slice("video_edit_menu:".length));
      const targets = listVideoTargets(backendDb, id).map((t) => t.target as VideoTarget);
      const keyboard = new InlineKeyboard();
      keyboard.text("✏️ Изменить имя карточки", `video_edit_field:label:${id}`).row();
      if (targets.includes("youtube_shorts")) {
        keyboard.text("✏️ Название YouTube", `video_edit_field:youtube_title:${id}`).row();
        keyboard.text("✏️ Описание YouTube", `video_edit_field:youtube_description:${id}`).row();
        keyboard.text("✏️ Теги YouTube", `video_edit_field:youtube_tags:${id}`).row();
      }
      if (targets.includes("instagram_reels")) {
        keyboard.text("✏️ Подпись Instagram", `video_edit_field:instagram_caption:${id}`).row();
      }
      keyboard.text("← Назад", `video_open:${id}`);
      await ctx.editMessageText("✏️ *Что изменить?*", { parse_mode: "Markdown", reply_markup: keyboard });
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
      else if (field === "instagram_caption") prompt = "⌨ Введите подпись для Instagram Reels — вместе с хэштегами (или «-»):";
      await replyVideoPrompt(ctx, prompt);
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
