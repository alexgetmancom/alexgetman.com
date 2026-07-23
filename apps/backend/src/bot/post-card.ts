import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../interfaces/telegram/i18n/index.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import { botLocale } from "./i18n.js";
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
): Promise<void> {
  const preview = draftPreview(backendDb, draftId, config, view);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
}

export async function editDraftPrompt(
  ctx: Context,
  backendDb: BackendDb,
  draftId: number,
  prompt: string,
  returnView: DraftView = "overview",
): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  await ctx.reply(prompt, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text(t(locale, "common.cancel"), `cancel_state:${draftId}:${returnView}`),
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
  const keyboard = new InlineKeyboard()
    .text(t(locale, "post.confirm-schedule-btn"), confirmCallback)
    .text(t(locale, "common.back"), `sched_view:${backView}:${draftId}`);
  const text = `${preview.text}\n\n📅 *${t(locale, "common.confirm-schedule")}*\nRU: ${formatMsk(ruAt, config)}\nEN: ${formatMsk(enAt, config)}`;
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
}
