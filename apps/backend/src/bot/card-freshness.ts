import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { telegramPostCard, telegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { POST_CARD_ACTION_KEYS } from "./post-routes.js";
import { callbackAction } from "./session-fsm.js";
import { VIDEO_CARD_ACTION_KEYS } from "./video-routes.js";

export type CardFreshnessDescriptor = {
  actions: readonly string[];
  entityType: "post" | "video";
  draftIdFrom: "first" | "last" | ((parts: readonly string[]) => string | undefined);
};

export const POST_CARD_FRESHNESS: CardFreshnessDescriptor = {
  actions: POST_CARD_ACTION_KEYS,
  entityType: "post",
  draftIdFrom: (parts) => (parts[0]?.startsWith("sched_") ? parts.at(-1) : parts[1]),
};

export const VIDEO_CARD_FRESHNESS: CardFreshnessDescriptor = {
  actions: VIDEO_CARD_ACTION_KEYS,
  entityType: "video",
  draftIdFrom: "last",
};

/** Rejects a callback from a card replaced by a newer Telegram control message. */
export function isStaleCardCallback(ctx: Context, backendDb: BackendDb, data: string, descriptor: CardFreshnessDescriptor): boolean {
  const action = callbackAction(data);
  if (!descriptor.actions.includes(action)) return false;
  const parts = data.split(":");
  const rawDraftId =
    typeof descriptor.draftIdFrom === "function"
      ? descriptor.draftIdFrom(parts)
      : descriptor.draftIdFrom === "first"
        ? parts[1]
        : parts.at(-1);
  const draftId = Number(rawDraftId);
  if (!Number.isSafeInteger(draftId) || draftId <= 0) return false;
  const currentMessageId =
    descriptor.entityType === "post" ? telegramPostCard(backendDb, draftId)?.messageId : telegramVideoCard(backendDb, draftId)?.messageId;
  return isStale(ctx, currentMessageId);
}

function isStale(ctx: Context, currentMessageId: number | undefined): boolean {
  const callbackMessage = ctx.callbackQuery?.message;
  const messageId = callbackMessage && "message_id" in callbackMessage ? callbackMessage.message_id : null;
  return messageId != null && currentMessageId != null && messageId !== currentMessageId;
}
