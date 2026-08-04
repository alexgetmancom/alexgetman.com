import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { telegramPostCard, telegramVideoCard } from "../interfaces/telegram/control-cards.js";
import {
  PUBLICATION_CARD_ACTIONS,
  type PublicationCallback,
  type PublicationKind,
  parseDraftId,
  parsePublicationCallback,
  parseSessionCallback,
} from "./session-fsm.js";

export type CardFreshnessDescriptor = {
  actions: readonly string[];
  kind: PublicationKind;
};

export const POST_CARD_FRESHNESS: CardFreshnessDescriptor = {
  actions: PUBLICATION_CARD_ACTIONS.post,
  kind: "post",
};

export const VIDEO_CARD_FRESHNESS: CardFreshnessDescriptor = {
  actions: PUBLICATION_CARD_ACTIONS.video,
  kind: "video",
};

/** Rejects a callback from a card replaced by a newer Telegram control message. */
export function isStaleCardCallback(
  ctx: Context,
  backendDb: BackendDb,
  callback: PublicationCallback | string,
  descriptor: CardFreshnessDescriptor,
): boolean {
  const publication = typeof callback === "string" ? parsePublicationCallback(parseSessionCallback(callback).data) : callback;
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
