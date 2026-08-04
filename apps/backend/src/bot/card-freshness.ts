import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { telegramPostCard, telegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { POST_CARD_ACTION_KEYS } from "./post-routes.js";
import {
  type PublicationCallback,
  type PublicationKind,
  parseDraftId,
  parseSessionCallback,
  publicationFromCallbackData,
} from "./session-fsm.js";
import { VIDEO_CARD_ACTION_KEYS } from "./video-routes.js";

export type CardFreshnessDescriptor = {
  actions: readonly string[];
  kind: PublicationKind;
};

export const POST_CARD_FRESHNESS: CardFreshnessDescriptor = {
  actions: POST_CARD_ACTION_KEYS,
  kind: "post",
};

export const VIDEO_CARD_FRESHNESS: CardFreshnessDescriptor = {
  actions: VIDEO_CARD_ACTION_KEYS,
  kind: "video",
};

/** Rejects a callback from a card replaced by a newer Telegram control message. */
export function isStaleCardCallback(
  ctx: Context,
  backendDb: BackendDb,
  callback: PublicationCallback | string,
  descriptor: CardFreshnessDescriptor,
): boolean {
  const publication = typeof callback === "string" ? publicationFromCallbackData(parseSessionCallback(callback).data) : callback;
  if (!publication || publication.kind !== descriptor.kind || !descriptor.actions.includes(publication.action)) return false;
  const draftId = parseDraftId(publication.args[0]);
  if (draftId == null) return false;
  const currentMessageId =
    descriptor.kind === "post" ? telegramPostCard(backendDb, draftId)?.messageId : telegramVideoCard(backendDb, draftId)?.messageId;
  return isStale(ctx, currentMessageId);
}

function isStale(ctx: Context, currentMessageId: number | undefined): boolean {
  const callbackMessage = ctx.callbackQuery?.message;
  const messageId = callbackMessage && "message_id" in callbackMessage ? callbackMessage.message_id : null;
  return messageId != null && currentMessageId != null && messageId !== currentMessageId;
}
