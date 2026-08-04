import type { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { setTelegramPostCard } from "../interfaces/telegram/control-cards.js";
import { createStudioServices } from "../studio/services/index.js";
import { appendPendingAlbum } from "./albums.js";
import { cancelPromptKeyboard } from "./dialog-ui.js";
import { botLocale } from "./i18n.js";
import { persistentKeyboard, showMainMenu } from "./menu-render.js";
import { extractMessage } from "./message.js";
import { applyAdminState } from "./post-actions.js";
import { sendDraftPreview } from "./post-card.js";
import { clearPostAdminState, getPostAdminState, startPostDialog } from "./post-state.js";
import { translatePostText } from "./post-translation.js";
import { parseSessionCallback, requireSessionRevision } from "./session-fsm.js";

/** The conversational text-post screen. It owns user input and keeps the
 * root bot router limited to authorization and screen dispatch.
 *
 * `reply` opens the screen as a new message; `edit` turns the message the
 * operator just tapped into it, which is what a callback should do. */
async function renderPostScreen(ctx: Context, backendDb: BackendDb, mode: "reply" | "edit"): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const revision = startPostDialog(backendDb, actorId);
  const locale = botLocale(backendDb, actorId);
  const prompt = t(locale, "post.dialog-prompt");
  const options = { reply_markup: cancelPromptKeyboard(locale, "cancel_dialog", revision) };
  if (mode === "edit") await ctx.editMessageText(prompt, options);
  else await ctx.reply(prompt, options);
}

export async function startPostScreen(ctx: Context, backendDb: BackendDb): Promise<void> {
  await renderPostScreen(ctx, backendDb, "reply");
}

export async function openPostScreen(ctx: Context, backendDb: BackendDb): Promise<void> {
  await renderPostScreen(ctx, backendDb, "edit");
}

export async function handlePostMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, actorId);
  const state = getPostAdminState(backendDb, actorId);
  const message = extractMessage(ctx);
  const mediaGroupId = ctx.message && "media_group_id" in ctx.message ? ctx.message.media_group_id : undefined;
  if (mediaGroupId && message.media.length > 0) {
    if (!state?.action || (state.action !== "new_post" && !state.draft_id)) {
      await ctx.reply(t(locale, "post.album-need-action"), { reply_markup: persistentKeyboard(locale) });
      return;
    }
    const media = message.media[0];
    if (!media) return;
    const isNew = appendPendingAlbum(backendDb, {
      actorId,
      chatId: Number(ctx.chat?.id),
      mediaGroupId,
      text: message.text,
      entities: message.entities,
      media,
      action: state.action,
      draftId: state.draft_id,
      stateRevision: state.revision,
    });
    if (isNew) await ctx.reply(t(locale, "post.album-received"));
    return;
  }
  if (state?.action && state.action !== "new_post" && state.draft_id) {
    try {
      await applyAdminState(ctx, backendDb, config, state.action, state.draft_id, state.control_message_id, state.revision);
    } catch (error) {
      const scheduleInput = state.action.startsWith("schedule_manual_");
      const errorText =
        error instanceof StudioError && error.code === "common.schedule-parse-error"
          ? t(locale, "common.schedule-parse-error", { timezone: config.TIMEZONE_LABEL })
          : describeError(locale, error);
      await ctx.reply(scheduleInput ? errorText : t(locale, "post.value-error", { error: errorText }));
    }
    return;
  }
  if (state?.action !== "new_post") {
    await ctx.reply(t(locale, "post.need-new-post"), { reply_markup: persistentKeyboard(locale) });
    return;
  }
  const textEn = await translatePostText(message.text, config);
  const draftId = createStudioServices(backendDb, config).publications.create(actorId, {
    kind: "post",
    message: { ...message, textEn },
  }).id;
  clearPostAdminState(backendDb, actorId);
  const control = await sendDraftPreview(ctx, backendDb, draftId, config);
  if (ctx.chat?.id) setTelegramPostCard(backendDb, draftId, Number(ctx.chat.id), control.message_id);
}

export async function handlePostScreenCallback(ctx: Context, backendDb: BackendDb, mainMenu: Menu<Context>): Promise<boolean> {
  const rawData = ctx.callbackQuery?.data;
  const { data, revision } = rawData ? parseSessionCallback(rawData) : { data: undefined, revision: null };
  if (data === "menu_text") {
    await ctx.answerCallbackQuery();
    await openPostScreen(ctx, backendDb);
    return true;
  }
  if (data === "cancel_dialog") {
    requireSessionRevision(getPostAdminState(backendDb, Number(ctx.from?.id))?.revision, revision);
    await ctx.answerCallbackQuery();
    clearPostAdminState(backendDb, Number(ctx.from?.id));
    // Cancelling is pure navigation, not a content change: turn this same
    // message back into the main menu instead of deleting and sending a new one.
    await showMainMenu(ctx, backendDb, mainMenu, true);
    return true;
  }
  return false;
}
