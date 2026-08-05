import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { telegramPostCard, telegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { POST_CARD_ACTIONS, type PublicationCallback, type PublicationKind, parseDraftId } from "./session-fsm.js";
import { isVideoCardAction, videoActionHandlers } from "./video-actions.js";

export type CardFreshnessDescriptor = {
  actions: readonly string[];
  kind: PublicationKind;
};

export const PUBLICATION_CARD_FRESHNESS: Record<PublicationKind, CardFreshnessDescriptor> = {
  post: { actions: POST_CARD_ACTIONS.post, kind: "post" },
  video: { actions: Object.keys(videoActionHandlers).filter(isVideoCardAction), kind: "video" },
};

/** Rejects a callback from a card replaced by a newer Telegram control message. */
export function isStaleCardCallback(
  ctx: Context,
  backendDb: BackendDb,
  callback: PublicationCallback,
  descriptors: Record<PublicationKind, CardFreshnessDescriptor> = PUBLICATION_CARD_FRESHNESS,
): boolean {
  const descriptor = descriptors[callback.kind];
  if (!descriptor.actions.includes(callback.action)) return false;
  const draftId = parseDraftId(callback.args[0]);
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
