import { type Context, type InlineKeyboard, InputFile } from "grammy";
import type { BackendDb } from "../db/client.js";
import { setTelegramPostCard, setTelegramPostProgressCard, setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { sendTelegramDeliveryPreviews } from "../interfaces/telegram/delivery-previews.js";
import type { DeliveryProjection } from "../studio/projections.js";
import type { ConversationStateInput } from "./conversation-state.js";
import { clearConversationState, saveConversationState } from "./conversation-state.js";
import type { BotLocale } from "./i18n.js";

type PublicationCard =
  | { kind: "post"; draftId: number }
  | { kind: "post-progress"; draftId: number; details?: boolean }
  | { kind: "video"; draftId: number };

/** Effects emitted by publication handlers and interpreted by one Telegram executor. */
export type PublicationEffect =
  | { type: "answer-callback"; text?: string; showAlert?: boolean }
  | { type: "toast"; text: string; showAlert?: boolean }
  | { type: "screen"; mode: "edit" | "reply"; text: string; options?: Record<string, unknown>; card?: PublicationCard }
  | { type: "prompt"; text: string; options?: Record<string, unknown>; card?: PublicationCard }
  | { type: "edit-message"; messageId: number; text: string; options?: Record<string, unknown> }
  | { type: "edit-reply-markup"; keyboard: InlineKeyboard }
  | { type: "photo"; path: string; options?: Record<string, unknown>; card?: PublicationCard }
  | { type: "delivery-previews"; projections: DeliveryProjection[]; locale: BotLocale }
  | { type: "session"; operation: "clear"; kind: "post" | "video"; actorId: number }
  | { type: "session"; operation: "save"; actorId: number; state: ConversationStateInput };

/** Executes transport effects in order, keeping callback acknowledgements in one place. */
export async function executePublicationEffects(ctx: Context, backendDb: BackendDb, effects: readonly PublicationEffect[]): Promise<void> {
  for (const effect of effects) {
    if (effect.type === "answer-callback") {
      await ctx.answerCallbackQuery(
        effect.text || effect.showAlert
          ? { ...(effect.text ? { text: effect.text } : {}), ...(effect.showAlert ? { show_alert: true } : {}) }
          : undefined,
      );
      continue;
    }
    if (effect.type === "toast") {
      await ctx.answerCallbackQuery({ text: effect.text, ...(effect.showAlert ? { show_alert: true } : {}) });
      continue;
    }
    if (effect.type === "screen" || effect.type === "prompt") {
      const mode = effect.type === "screen" ? effect.mode : "reply";
      const message =
        mode === "edit" ? await ctx.editMessageText(effect.text, effect.options) : await ctx.reply(effect.text, effect.options);
      const messageId = mode === "edit" ? callbackMessageId(ctx) : typeof message === "boolean" ? null : message.message_id;
      if (messageId != null) bindCard(backendDb, ctx, effect.card, messageId);
      continue;
    }
    if (effect.type === "edit-reply-markup") {
      await ctx.editMessageReplyMarkup({ reply_markup: effect.keyboard });
      continue;
    }
    if (effect.type === "edit-message") {
      if (ctx.chat?.id != null) await ctx.api.editMessageText(ctx.chat.id, effect.messageId, effect.text, effect.options);
      continue;
    }
    if (effect.type === "photo") {
      const message = await ctx.replyWithPhoto(new InputFile(effect.path), effect.options);
      bindCard(backendDb, ctx, effect.card, message.message_id);
      continue;
    }
    if (effect.type === "delivery-previews") {
      await sendTelegramDeliveryPreviews(ctx, effect.projections, effect.locale);
      continue;
    }
    if (effect.operation === "clear") {
      clearConversationState(backendDb, effect.actorId, effect.kind);
    } else {
      saveConversationState(backendDb, effect.actorId, effect.state);
    }
  }
}

function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}

function bindCard(backendDb: BackendDb, ctx: Context, card: PublicationCard | undefined, messageId: number): void {
  if (!card || ctx.chat?.id == null) return;
  const chatId = Number(ctx.chat.id);
  if (card.kind === "post") setTelegramPostCard(backendDb, card.draftId, chatId, messageId);
  else if (card.kind === "post-progress") setTelegramPostProgressCard(backendDb, card.draftId, chatId, messageId, Boolean(card.details));
  else setTelegramVideoCard(backendDb, card.draftId, chatId, messageId);
}
