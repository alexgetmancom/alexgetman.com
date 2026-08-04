import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { setTelegramPostCard } from "../interfaces/telegram/control-cards.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import { cancelPromptKeyboard, confirmationKeyboard } from "./dialog-ui.js";
import { botLocale } from "./i18n.js";
import { getPostAdminState } from "./post-state.js";
import { type DraftView, draftPreview } from "./preview.js";

/** Telegram rendering for a post control card; mutations stay in post actions. */
export async function sendDraftPreview(ctx: Pick<Context, "reply">, backendDb: BackendDb, draftId: number, config: BackendConfig) {
  const preview = draftPreview(backendDb, draftId, config);
  return ctx.reply(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
}

export async function editDraftPreview(
  ctx: Context,
  backendDb: BackendDb,
  draftId: number,
  config: BackendConfig,
  view: DraftView = "overview",
  callbackText?: string,
): Promise<void> {
  const preview = draftPreview(backendDb, draftId, config, view);
  const messageId = callbackMessageId(ctx);
  await ctx.answerCallbackQuery(callbackText ? { text: callbackText } : {});
  await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  if (ctx.chat?.id != null && messageId != null) setTelegramPostCard(backendDb, draftId, ctx.chat.id, messageId);
}

export async function editDraftPrompt(
  ctx: Context,
  backendDb: BackendDb,
  draftId: number,
  prompt: string,
  returnView: DraftView = "overview",
): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, actorId);
  const revision = getPostAdminState(backendDb, actorId)?.revision;
  await ctx.reply(prompt, {
    parse_mode: "Markdown",
    reply_markup: cancelPromptKeyboard(locale, `cancel_state:${draftId}:${returnView}`, revision),
  });
}

export async function showScheduleConfirmation(
  ctx: Context,
  backendDb: BackendDb,
  draftId: number,
  config: BackendConfig,
  ruAt: Date | null,
  enAt: Date | null,
  confirmCallback: string,
  backView: DraftView = "schedule",
): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const preview = draftPreview(backendDb, draftId, config);
  const keyboard = confirmationKeyboard(
    { label: t(locale, "post.confirm-schedule-btn"), callback: confirmCallback },
    { label: t(locale, "common.back"), callback: `sched_view:${backView}:${draftId}` },
  );
  const text = `${preview.text}\n\n📅 *${t(locale, "common.confirm-schedule")}*\nRU: ${formatMsk(ruAt, config)}\nEN: ${formatMsk(enAt, config)}`;
  const message = await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
  if (ctx.chat?.id != null) setTelegramPostCard(backendDb, draftId, ctx.chat.id, message.message_id);
}

function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}
