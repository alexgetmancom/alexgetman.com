import { type Context, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { videoPreview } from "../interfaces/telegram/video-preview.js";
import { studioServices } from "../studio/services/index.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../video/types.js";
import { botLocale } from "./i18n.js";
import { startVideoConversation } from "./video-conversation.js";
import { finishVideoSchedule } from "./video-scheduling.js";
import {
  askInstagramOrSchedule,
  callbackMessageId,
  clearSession,
  getSession,
  replyVideoPrompt,
  saveSession,
  setControlFromSession,
  setData,
  targetKeyboard,
  updateVideoControl,
} from "./video-session.js";

/** Callback-only adapter: it changes a session or invokes a Studio command, never parses chat replies. */
export async function handleVideoActionCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("video_")) return false;
  const adminId = Number(ctx.from?.id);
  try {
    if (data === "video_start") await startVideoConversation(ctx, backendDb);
    else if (data === "video_cancel_dialog") {
      clearSession(backendDb, adminId);
      await ctx.answerCallbackQuery();
      try {
        await ctx.deleteMessage();
      } catch {}
      const keyboard = new InlineKeyboard();
      if (config.studio.modules.text_posting) keyboard.text("📝 Новый пост", "menu_text");
      if (config.studio.modules.video_posting) keyboard.text("🎬 Новое видео", "video_start");
      keyboard.row().text("📋 Очередь", "queue_home");
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
      studioServices(backendDb, config).videos.replaceTargets(adminId, session.draftId, session.selected);
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
      studioServices(backendDb, config).videos.details(adminId, id);
      const preview = videoPreview(backendDb, id, botLocale(backendDb, adminId));
      const messageId = callbackMessageId(ctx);
      if (messageId && ctx.chat?.id) studioServices(backendDb, config).videos.setControlCard(adminId, id, Number(ctx.chat.id), messageId);
      await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
    } else if (data.startsWith("video_retry:")) {
      const [, target, idText] = data.split(":");
      const targetName = target as VideoTarget;
      const id = Number(idText);
      if (!VIDEO_TARGETS.includes(targetName)) throw new Error("Неизвестная площадка.");
      studioServices(backendDb, config).videos.retry(adminId, id, targetName);
      const preview = videoPreview(backendDb, id, botLocale(backendDb, adminId));
      await ctx.answerCallbackQuery({ text: `${videoTargetLabel(targetName)} снова поставлен в очередь` });
      await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
      return true;
    } else if (data.startsWith("video_schedule_confirm:")) {
      const id = Number(data.slice("video_schedule_confirm:".length));
      const session = getSession(backendDb, adminId);
      if (!session || session.draftId !== id || session.step !== "schedule_confirm") throw new Error("Schedule confirmation expired.");
      const values = session.data.schedule as Record<string, string> | undefined;
      if (!values) throw new Error("Schedule confirmation expired.");
      await finishVideoSchedule(
        ctx,
        backendDb,
        config,
        adminId,
        session,
        Object.fromEntries(Object.entries(values).map(([target, value]) => [target, new Date(value)])) as Partial<
          Record<VideoTarget, Date>
        >,
      );
    } else if (await handleScheduleCallback(ctx, backendDb, config, adminId, data)) {
      // handled above
    } else if (data.startsWith("video_now:")) {
      const id = Number(data.slice("video_now:".length));
      studioServices(backendDb, config).videos.details(adminId, id);
      const preview = videoPreview(backendDb, id, botLocale(backendDb, adminId));
      await ctx.editMessageText(`${preview.text}\n\n⚠️ *Опубликовать сейчас?* Видео будет поставлено в очередь на ближайшую минуту.`, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("✅ Да, опубликовать", `video_now_confirm:${id}`).text("← Назад", `video_open:${id}`),
      });
    } else if (data.startsWith("video_now_confirm:")) {
      const id = Number(data.slice("video_now_confirm:".length));
      const targets = studioServices(backendDb, config)
        .videos.details(adminId, id)
        .targets.map((row) => row.target as VideoTarget);
      await finishVideoSchedule(
        ctx,
        backendDb,
        config,
        adminId,
        { draftId: id, step: "", selected: targets, data: { controlMessageId: callbackMessageId(ctx) } },
        Object.fromEntries(targets.map((target) => [target, new Date(Date.now() + 60_000)])),
      );
    } else if (data.startsWith("video_cancel:")) {
      studioServices(backendDb, config).videos.cancel(adminId, Number(data.slice("video_cancel:".length)));
      clearSession(backendDb, adminId);
      await ctx.editMessageText(`🗑 Видеопубликация отменена. Исходник останется на сервере ещё ${config.VIDEO_MEDIA_RETENTION_HOURS} ч.`);
    } else if (data.startsWith("video_time:")) {
      const [, targetText, idText] = data.split(":");
      const target = targetText as VideoTarget;
      const id = Number(idText);
      studioServices(backendDb, config).videos.details(adminId, id);
      const session = {
        draftId: id,
        step: `schedule_target:${target}`,
        selected: [target],
        data: { controlMessageId: callbackMessageId(ctx) },
      };
      saveSession(backendDb, adminId, session);
      setControlFromSession(backendDb, config, adminId, id, ctx, session);
      await replyVideoPrompt(ctx, `⌨ Когда опубликовать на ${videoTargetLabel(target)}? Формат: 15.07 18:30 (МСК).`);
    } else if (data.startsWith("video_remove:")) {
      const [, targetText, idText] = data.split(":");
      const target = targetText as VideoTarget;
      const id = Number(idText);
      const { cancelled } = studioServices(backendDb, config).videos.removeTarget(adminId, id, target);
      if (cancelled) {
        clearSession(backendDb, adminId);
        await ctx.editMessageText("🗑 Все платформы удалены. Публикация отменена.");
      } else {
        await ctx.answerCallbackQuery({ text: `${videoTargetLabel(target)} removed` });
        const preview = videoPreview(backendDb, id, botLocale(backendDb, adminId));
        await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
      }
      return true;
    } else if (await handleEditMenuCallback(ctx, backendDb, config, adminId, data)) return true;
    else if (data.startsWith("video_edit:")) {
      const id = Number(data.slice("video_edit:".length));
      const details = studioServices(backendDb, config).videos.details(adminId, id);
      const session = {
        draftId: id,
        step: "label",
        selected: details.targets.map((row) => row.target as VideoTarget),
        data: { controlMessageId: callbackMessageId(ctx) },
      };
      saveSession(backendDb, adminId, session);
      setControlFromSession(backendDb, config, adminId, id, ctx, session);
      await replyVideoPrompt(ctx, "⌨ Введите новую внутреннюю подпись видео:");
    }
    await ctx.answerCallbackQuery();
  } catch (error) {
    await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Ошибка" });
  }
  return true;
}

async function handleScheduleCallback(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  data: string,
): Promise<boolean> {
  if (data.startsWith("video_schedule:")) {
    const id = Number(data.slice("video_schedule:".length));
    const targets = studioServices(backendDb, config)
      .videos.details(adminId, id)
      .targets.map((row) => row.target as VideoTarget);
    if (!targets.length) throw new Error("У видео не выбраны платформы.");
    const keyboard = new InlineKeyboard().text("Одно время для всех", `video_common:${id}`);
    if (targets.length > 1) keyboard.row().text("Разное время", `video_individual:${id}`);
    const session = { draftId: id, step: "schedule_choice", selected: targets, data: { controlMessageId: callbackMessageId(ctx) } };
    saveSession(backendDb, adminId, session);
    setControlFromSession(backendDb, config, adminId, id, ctx, session);
    await updateVideoControl(ctx, session, "📅 Время публикации (МСК):", keyboard);
    return true;
  }
  if (!data.startsWith("video_common:") && !data.startsWith("video_individual:")) return false;
  const id = Number(data.split(":")[1]);
  const session = getSession(backendDb, adminId);
  const targets = studioServices(backendDb, config)
    .videos.details(adminId, id)
    .targets.map((row) => row.target as VideoTarget);
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

async function handleEditMenuCallback(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  data: string,
): Promise<boolean> {
  if (data.startsWith("video_edit_menu:")) {
    const id = Number(data.slice("video_edit_menu:".length));
    const targets = studioServices(backendDb, config)
      .videos.details(adminId, id)
      .targets.map((target) => target.target as VideoTarget);
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
  const targets = studioServices(backendDb, config).videos.details(adminId, id).targets;
  const session = {
    draftId: id,
    step: field,
    selected: targets.map((target) => target.target as VideoTarget),
    data: { controlMessageId: callbackMessageId(ctx), is_single_edit: true },
  };
  saveSession(backendDb, adminId, session);
  setControlFromSession(backendDb, config, adminId, id, ctx, session);
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
