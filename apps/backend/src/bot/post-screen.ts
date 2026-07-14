import { type Context, InlineKeyboard } from "grammy";
import { translateToEnglish } from "../content/translation.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { studioServices } from "../studio/services/index.js";
import { appendPendingAlbum } from "./albums.js";
import { botLocale, ui } from "./i18n.js";
import { extractMessage } from "./message.js";
import { persistentKeyboard, showMainMenu } from "./navigation.js";
import { applyAdminState } from "./post-actions.js";
import { sendDraftPreview } from "./post-card.js";
import { clearPostAdminState, getPostAdminState, startPostDialog } from "./post-state.js";

/** The conversational text-post screen. It owns user input and keeps the
 * root bot router limited to authorization and screen dispatch. */
export async function startPostScreen(ctx: Context, backendDb: BackendDb): Promise<void> {
  const adminId = Number(ctx.from?.id);
  startPostDialog(backendDb, adminId);
  const locale = botLocale(backendDb, adminId);
  await ctx.reply(
    ui(
      locale,
      "📝 Send text with optional photos or video for a new post.",
      "📝 Пришлите текст с опциональным фото или видео для нового поста.",
    ),
    { reply_markup: new InlineKeyboard().text(ui(locale, "← Cancel", "← Отмена"), "cancel_dialog") },
  );
}

async function openPostScreen(ctx: Context, backendDb: BackendDb): Promise<void> {
  const adminId = Number(ctx.from?.id);
  startPostDialog(backendDb, adminId);
  const locale = botLocale(backendDb, adminId);
  await ctx.editMessageText(
    ui(
      locale,
      "📝 Send text with optional photos or video for a new post.",
      "📝 Пришлите текст с опциональным фото или видео для нового поста.",
    ),
    { reply_markup: new InlineKeyboard().text(ui(locale, "← Cancel", "← Отмена"), "cancel_dialog") },
  );
}

export async function handlePostMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
  const adminId = Number(ctx.from?.id);
  const state = getPostAdminState(backendDb, adminId);
  const message = extractMessage(ctx);
  const mediaGroupId = ctx.message && "media_group_id" in ctx.message ? ctx.message.media_group_id : undefined;
  if (mediaGroupId && message.media.length > 0) {
    const media = message.media[0];
    if (!media) return;
    const isNew = appendPendingAlbum(backendDb, {
      adminId,
      chatId: Number(ctx.chat?.id),
      mediaGroupId,
      text: message.text,
      entities: message.entities,
      media,
      action: state?.action ?? null,
      draftId: state?.draft_id ?? null,
    });
    if (isNew) await ctx.reply("Album received. I will create or update the draft in a few seconds.");
    return;
  }
  if (state?.action && state.action !== "new_post" && state.draft_id) {
    try {
      await applyAdminState(ctx, backendDb, config, state.action, state.draft_id, state.control_message_id);
    } catch (error) {
      const locale = botLocale(backendDb, adminId);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const scheduleInput = state.action.startsWith("schedule_manual_");
      await ctx.reply(
        scheduleInput
          ? ui(
              locale,
              "I couldn't read that date and time. Send `HH:MM` or `DD.MM HH:MM` in MSK, for example `15.07 18:30`.",
              "Не удалось распознать дату и время. Отправьте `ЧЧ:ММ` или `ДД.ММ ЧЧ:ММ` по МСК, например `15.07 18:30`.",
            )
          : ui(
              locale,
              `I couldn't use that value: ${errorMessage}\n\nPlease try again or tap Cancel.`,
              `Не удалось обработать значение: ${errorMessage}\n\nПопробуйте ещё раз или нажмите «Отмена».`,
            ),
      );
    }
    return;
  }
  if (state?.action !== "new_post") {
    const locale = botLocale(backendDb, adminId);
    await ctx.reply(
      ui(locale, "Choose 📝 New post from the menu before sending a new publication.", "Сначала выберите «📝 Новый пост» в меню."),
      { reply_markup: persistentKeyboard(locale) },
    );
    return;
  }
  let textEn = message.text;
  try {
    textEn = await translateToEnglish(message.text, config);
  } catch (error) {
    log("warn", "draft translation failed", { error: String(error) });
  }
  const draftId = studioServices(backendDb, config).posts.create(adminId, { ...message, textEn });
  clearPostAdminState(backendDb, adminId);
  const control = await sendDraftPreview(ctx, backendDb, draftId);
  if (ctx.chat?.id) studioServices(backendDb, config).posts.setControlCard(adminId, draftId, Number(ctx.chat.id), control.message_id);
}

export async function handlePostScreenCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  if (ctx.callbackQuery?.data === "menu_text") {
    await ctx.answerCallbackQuery();
    await openPostScreen(ctx, backendDb);
    return true;
  }
  if (ctx.callbackQuery?.data === "cancel_dialog") {
    await ctx.answerCallbackQuery();
    clearPostAdminState(backendDb, Number(ctx.from?.id));
    try {
      await ctx.deleteMessage();
    } catch {}
    await showMainMenu(ctx, config, backendDb);
    return true;
  }
  return false;
}
