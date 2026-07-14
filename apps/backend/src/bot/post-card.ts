import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { formatMsk } from "../publishing/schedule.js";
import { botLocale, ui } from "./i18n.js";
import { type DraftView, draftPreview } from "./preview.js";

/** Telegram rendering for a post control card; mutations stay in post actions. */
export async function sendDraftPreview(ctx: Pick<Context, "reply">, backendDb: BackendDb, draftId: number) {
  const preview = draftPreview(backendDb, draftId);
  return ctx.reply(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
}

export async function editDraftPreview(ctx: Context, backendDb: BackendDb, draftId: number, view: DraftView = "overview"): Promise<void> {
  const preview = draftPreview(backendDb, draftId, view);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
}

export async function editDraftPrompt(ctx: Context, backendDb: BackendDb, draftId: number, prompt: string): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const preview = draftPreview(backendDb, draftId);
  await ctx.editMessageText(`${preview.text}\n\n${prompt}`, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text(ui(locale, "← Cancel", "← Отмена"), `cancel_state:${draftId}`),
  });
}

export async function showScheduleConfirmation(
  ctx: Context,
  backendDb: BackendDb,
  draftId: number,
  ruAt: Date | null,
  enAt: Date | null,
  confirmCallback: string,
  controlMessageId?: number | null,
): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const preview = draftPreview(backendDb, draftId);
  const keyboard = new InlineKeyboard()
    .text(ui(locale, "✅ Confirm schedule", "✅ Подтвердить"), confirmCallback)
    .text(ui(locale, "← Back", "← Назад"), `schedule:${draftId}`);
  const text = `${preview.text}\n\n📅 *${ui(locale, "Confirm schedule", "Подтвердите планирование")}*\nRU: ${formatMsk(ruAt)}\nEN: ${formatMsk(enAt)}`;
  const messageId = controlMessageId ?? callbackMessageId(ctx);
  if (messageId && ctx.chat?.id)
    await ctx.api.editMessageText(ctx.chat.id, messageId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  else await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}
