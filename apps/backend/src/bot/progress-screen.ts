import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { setTelegramPostProgressCard } from "../interfaces/telegram/control-cards.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale } from "./i18n.js";
import { renderPostProgress } from "./progress.js";

/** Render and update one durable publication-progress card in place. */
export async function handleProgressCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  const details = data.match(/^progress_details:(\d+)$/);
  const overview = data.match(/^progress:(\d+)$/);
  const cancel = data.match(/^progress_cancel:(\d+)$/);
  const match = details ?? overview ?? cancel;
  if (!match) return false;
  const draftId = Number(match[1]);
  if (!Number.isSafeInteger(draftId)) {
    await ctx.answerCallbackQuery({ text: "Bad draft id" });
    return true;
  }
  const actorId = Number(ctx.from?.id);
  if (cancel) {
    studioServices(backendDb, config).posts.cancelRemaining(actorId, draftId);
    await ctx.answerCallbackQuery({ text: "Remaining work cancelled" });
  } else await ctx.answerCallbackQuery();
  const progress = renderPostProgress(
    studioServices(backendDb, config).posts.progress(actorId, draftId),
    botLocale(backendDb, actorId),
    Boolean(details),
  );
  await ctx.editMessageText(progress.text, { parse_mode: "Markdown", reply_markup: progress.keyboard });
  const messageId = ctx.callbackQuery?.message && "message_id" in ctx.callbackQuery.message ? ctx.callbackQuery.message.message_id : null;
  if (messageId && ctx.chat?.id) setTelegramPostProgressCard(backendDb, draftId, Number(ctx.chat.id), messageId, Boolean(details));
  return true;
}
