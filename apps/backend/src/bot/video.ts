import { eq } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { videoBotSessions } from "../db/schema.js";
import { parseManualSchedule } from "../publishingSchedule.js";
import {
  cancelVideo,
  createVideoDraft,
  listVideoTargets,
  replaceVideoTargets,
  saveVideoMetadata,
  scheduledVideos,
  scheduleVideo,
  updateVideoLabel,
  videoPreview,
} from "../video/service.js";
import { storeTelegramVideo } from "../video/storage.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../video/types.js";

type Session = { draftId: number | null; step: string; selected: VideoTarget[]; data: Record<string, unknown> };

export async function startVideoFlow(ctx: Context, backendDb: BackendDb): Promise<void> {
  const adminId = Number(ctx.from?.id);
  saveSession(backendDb, adminId, { draftId: null, step: "asset", selected: [], data: {} });
  await ctx.reply("🎬 Пришлите видео MP4. После загрузки я попрошу короткую подпись, платформы и параметры публикации.");
}

export async function showUnpublishedVideos(ctx: Context, backendDb: BackendDb): Promise<void> {
  const rows = scheduledVideos(backendDb);
  if (!rows.length) return void (await ctx.reply("Нет отложенных видеопубликаций."));
  const keyboard = new InlineKeyboard();
  for (const row of rows.slice(0, 20)) keyboard.text(`🎬 ${row.label || `Видео #${row.id}`}`, `video_open:${row.id}`).row();
  await ctx.reply("Неопубликованные видео:", { reply_markup: keyboard });
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
      saveSession(backendDb, adminId, { draftId, step: "label", selected: [], data: {} });
      await ctx.reply("Как кратко назвать это видео для списка? Например: «Hades, часть 3». Это только внутренняя подпись.");
      return true;
    }
    const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
    if (!text) {
      await ctx.reply("Сейчас жду текстовый ответ. Или отправьте /start, чтобы начать заново.");
      return true;
    }
    if (!session.draftId) return false;
    if (session.step === "label") {
      updateVideoLabel(backendDb, session.draftId, text);
      saveSession(backendDb, adminId, { ...session, step: "targets" });
      await ctx.reply("Выберите платформы, затем нажмите «Далее».", { reply_markup: targetKeyboard(config, []) });
      return true;
    }
    if (session.step === "youtube_title") {
      setData(backendDb, adminId, session, "youtube_title", text, "youtube_description");
      await ctx.reply("Описание для YouTube (можно отправить «-», если не нужно):");
      return true;
    }
    if (session.step === "youtube_description") {
      setData(backendDb, adminId, session, "youtube_description", text === "-" ? "" : text, "youtube_tags");
      await ctx.reply("Теги YouTube через запятую (или «-»):");
      return true;
    }
    if (session.step === "youtube_tags") {
      const metadata = {
        title: String(session.data.youtube_title ?? ""),
        description: String(session.data.youtube_description ?? ""),
        tags:
          text === "-"
            ? []
            : text
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
      };
      saveVideoMetadata(backendDb, session.draftId, "youtube_shorts", metadata);
      await askInstagramOrSchedule(ctx, backendDb, adminId, session);
      return true;
    }
    if (session.step === "instagram_caption") {
      setData(backendDb, adminId, session, "instagram_caption", text === "-" ? "" : text, "instagram_hashtags");
      await ctx.reply("Хэштеги Instagram через пробел или запятую (или «-»):");
      return true;
    }
    if (session.step === "instagram_hashtags") {
      const metadata = {
        caption: String(session.data.instagram_caption ?? ""),
        hashtags:
          text === "-"
            ? []
            : text
                .split(/[\s,]+/)
                .map((tag) => tag.trim())
                .filter(Boolean)
                .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)),
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
        await ctx.reply(`Когда опубликовать на ${videoTargetLabel(remaining)}? Формат: 15.07 18:30 (МСК).`);
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
    await ctx.reply(`Не получилось: ${error instanceof Error ? error.message : String(error)}`);
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
    else if (data === "video_list") await showUnpublishedVideos(ctx, backendDb);
    else if (data.startsWith("video_toggle:")) {
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
        saveSession(backendDb, adminId, { ...session, step: "youtube_title" });
        await ctx.reply("Название для YouTube Shorts:");
      } else await askInstagramOrSchedule(ctx, backendDb, adminId, session);
    } else if (data.startsWith("video_open:")) {
      const id = Number(data.slice("video_open:".length));
      const preview = videoPreview(backendDb, id);
      await ctx.reply(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
    } else if (data.startsWith("video_schedule:")) {
      const id = Number(data.slice("video_schedule:".length));
      const targets = listVideoTargets(backendDb, id).map((row) => row.target as VideoTarget);
      if (!targets.length) throw new Error("У видео не выбраны платформы.");
      saveSession(backendDb, adminId, { draftId: id, step: "schedule_choice", selected: targets, data: {} });
      const keyboard = new InlineKeyboard().text("Одно время для всех", `video_common:${id}`);
      if (targets.length > 1) keyboard.row().text("Разное время", `video_individual:${id}`);
      await ctx.reply("Время публикации (МСК):", { reply_markup: keyboard });
    } else if (data.startsWith("video_common:") || data.startsWith("video_individual:")) {
      const id = Number(data.split(":")[1]);
      const session = getSession(backendDb, adminId);
      const targets = listVideoTargets(backendDb, id).map((row) => row.target as VideoTarget);
      if (!session || !targets.length) throw new Error("Откройте публикацию ещё раз.");
      if (data.startsWith("video_common:")) {
        saveSession(backendDb, adminId, { ...session, draftId: id, selected: targets, step: "schedule_common" });
        await ctx.reply("Введите дату и время, например: 15.07 18:30 (МСК).");
      } else {
        const first = targets[0];
        if (!first) throw new Error("У видео не выбраны платформы.");
        saveSession(backendDb, adminId, {
          ...session,
          draftId: id,
          selected: targets,
          step: `schedule_target:${first}`,
          data: { schedule: {} },
        });
        await ctx.reply(`Когда опубликовать на ${videoTargetLabel(first)}? Формат: 15.07 18:30 (МСК).`);
      }
    } else if (data.startsWith("video_now:")) {
      const id = Number(data.slice("video_now:".length));
      const targets = listVideoTargets(backendDb, id).map((row) => row.target as VideoTarget);
      await finishSchedule(
        ctx,
        backendDb,
        config,
        adminId,
        { draftId: id, step: "", selected: targets, data: {} },
        Object.fromEntries(targets.map((target) => [target, new Date(Date.now() + 60_000)])),
      );
    } else if (data.startsWith("video_cancel:")) {
      cancelVideo(backendDb, Number(data.slice("video_cancel:".length)), config.VIDEO_MEDIA_RETENTION_HOURS);
      clearSession(backendDb, adminId);
      await ctx.reply(`Видеопубликация отменена. Исходник останется на сервере ещё ${config.VIDEO_MEDIA_RETENTION_HOURS} ч.`);
    } else if (data.startsWith("video_edit:")) {
      const id = Number(data.slice("video_edit:".length));
      saveSession(backendDb, adminId, {
        draftId: id,
        step: "label",
        selected: listVideoTargets(backendDb, id).map((row) => row.target as VideoTarget),
        data: {},
      });
      await ctx.reply("Введите новую внутреннюю подпись видео:");
    }
    await ctx.answerCallbackQuery();
  } catch (error) {
    await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Ошибка" });
  }
  return true;
}

async function askInstagramOrSchedule(ctx: Context, backendDb: BackendDb, adminId: number, session: Session): Promise<void> {
  if (session.selected.includes("instagram_reels")) {
    saveSession(backendDb, adminId, { ...session, step: "instagram_caption" });
    await ctx.reply("Описание для Instagram Reels (или «-»):");
  } else await askSchedule(ctx, backendDb, adminId, session);
}

async function askSchedule(ctx: Context, backendDb: BackendDb, adminId: number, session: Session): Promise<void> {
  saveSession(backendDb, adminId, { ...session, step: "schedule_choice" });
  const keyboard = new InlineKeyboard().text("Одно время для всех", `video_common:${session.draftId}`);
  if (session.selected.length > 1) keyboard.row().text("Разное время", `video_individual:${session.draftId}`);
  await ctx.reply("Данные сохранены. Выберите расписание (МСК):", { reply_markup: keyboard });
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
  scheduleVideo(backendDb, session.draftId, schedule, {
    prepareLeadMinutes: config.VIDEO_PREPARE_LEAD_MINUTES,
    reminderMinutes: config.VIDEO_REMINDER_MINUTES,
  });
  clearSession(backendDb, adminId);
  const preview = videoPreview(backendDb, session.draftId);
  await ctx.reply(`✅ Запланировано. Напомню за ${config.VIDEO_REMINDER_MINUTES} минут.\n\n${preview.text}`, {
    parse_mode: "Markdown",
    reply_markup: preview.keyboard,
  });
}

function targetKeyboard(config: BackendConfig, selected: VideoTarget[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const target of VIDEO_TARGETS) {
    if (target === "youtube_shorts" && !config.studio.modules.youtube) continue;
    if (target === "instagram_reels" && !config.studio.modules.instagram) continue;
    keyboard.text(`${selected.includes(target) ? "✓" : "○"} ${videoTargetLabel(target)}`, `video_toggle:${target}`).row();
  }
  return keyboard.text("Далее", "video_targets_done");
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

function setData(backendDb: BackendDb, adminId: number, session: Session, key: string, value: unknown, nextStep: string): void {
  saveSession(backendDb, adminId, { ...session, step: nextStep, data: { ...session.data, [key]: value } });
}

function clearSession(backendDb: BackendDb, adminId: number): void {
  backendDb.db.delete(videoBotSessions).where(eq(videoBotSessions.adminId, adminId)).run();
}
