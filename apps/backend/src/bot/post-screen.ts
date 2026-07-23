import type { Menu } from "@grammyjs/menu";
import { type Context, InlineKeyboard } from "grammy";
import { translateToEnglish } from "../content/translation.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { setTelegramPostCard } from "../interfaces/telegram/control-cards.js";
import { describeError, t } from "../interfaces/telegram/i18n/index.js";
import { studioServices } from "../studio/services/index.js";
import { appendPendingAlbum } from "./albums.js";
import { botLocale } from "./i18n.js";
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
  await ctx.reply(t(locale, "post.dialog-prompt"), {
    reply_markup: new InlineKeyboard().text(t(locale, "common.cancel"), "cancel_dialog"),
  });
}

export async function openPostScreen(ctx: Context, backendDb: BackendDb): Promise<void> {
  const adminId = Number(ctx.from?.id);
  startPostDialog(backendDb, adminId);
  const locale = botLocale(backendDb, adminId);
  await ctx.editMessageText(t(locale, "post.dialog-prompt"), {
    reply_markup: new InlineKeyboard().text(t(locale, "common.cancel"), "cancel_dialog"),
  });
}

export async function handlePostMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
  const adminId = Number(ctx.from?.id);
  const state = getPostAdminState(backendDb, adminId);
  const message = extractMessage(ctx);
  const mediaGroupId = ctx.message && "media_group_id" in ctx.message ? ctx.message.media_group_id : undefined;
  if (mediaGroupId && message.media.length > 0) {
    if (!state?.action || (state.action !== "new_post" && !state.draft_id)) {
      const locale = botLocale(backendDb, adminId);
      await ctx.reply(t(locale, "post.album-need-action"), { reply_markup: persistentKeyboard(locale) });
      return;
    }
    const media = message.media[0];
    if (!media) return;
    const isNew = appendPendingAlbum(backendDb, {
      adminId,
      chatId: Number(ctx.chat?.id),
      mediaGroupId,
      text: message.text,
      entities: message.entities,
      media,
      action: state.action,
      draftId: state.draft_id,
    });
    if (isNew) await ctx.reply(t(botLocale(backendDb, adminId), "post.album-received"));
    return;
  }
  if (state?.action && state.action !== "new_post" && state.draft_id) {
    try {
      await applyAdminState(ctx, backendDb, config, state.action, state.draft_id, state.control_message_id);
    } catch (error) {
      const locale = botLocale(backendDb, adminId);
      const scheduleInput = state.action.startsWith("schedule_manual_");
      await ctx.reply(
        scheduleInput ? t(locale, "common.schedule-parse-error") : t(locale, "post.value-error", { error: describeError(locale, error) }),
      );
    }
    return;
  }
  if (state?.action !== "new_post") {
    const locale = botLocale(backendDb, adminId);
    await ctx.reply(t(locale, "post.need-new-post"), { reply_markup: persistentKeyboard(locale) });
    return;
  }
  let textEn = message.text;
  try {
    textEn = await translateToEnglish(message.text, config);
  } catch (error) {
    log("warn", "draft translation failed", { error: String(error) });
  }
  const draftId = studioServices(backendDb, config).publications.create(adminId, { kind: "post", message: { ...message, textEn } }).id;
  clearPostAdminState(backendDb, adminId);
  const control = await sendDraftPreview(ctx, backendDb, draftId, config);
  if (ctx.chat?.id) setTelegramPostCard(backendDb, draftId, Number(ctx.chat.id), control.message_id);
}

export async function handlePostScreenCallback(ctx: Context, backendDb: BackendDb, mainMenu: Menu<Context>): Promise<boolean> {
  if (ctx.callbackQuery?.data === "menu_text") {
    await ctx.answerCallbackQuery();
    await openPostScreen(ctx, backendDb);
    return true;
  }
  if (ctx.callbackQuery?.data === "cancel_dialog") {
    await ctx.answerCallbackQuery();
    clearPostAdminState(backendDb, Number(ctx.from?.id));
    // Cancelling is pure navigation, not a content change: turn this same
    // message back into the main menu instead of deleting and sending a new one.
    await showMainMenu(ctx, backendDb, mainMenu, true);
    return true;
  }
  return false;
}
