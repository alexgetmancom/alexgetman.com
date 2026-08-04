import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { telegramPostCard, telegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { callbackAction, POST_CARD_ACTION_KEYS } from "./post-routes.js";
import { VIDEO_CARD_ACTION_KEYS } from "./video-routes.js";

const POST_CARD_ACTIONS: ReadonlySet<string> = new Set(POST_CARD_ACTION_KEYS);

const VIDEO_CARD_ACTIONS: ReadonlySet<string> = new Set(VIDEO_CARD_ACTION_KEYS);

/** Old post cards must not mutate a draft after a newer card has replaced them. */
export function isStalePostCardCallback(ctx: Context, backendDb: BackendDb, action: string, draftId: number): boolean {
  if (!POST_CARD_ACTIONS.has(action)) return false;
  return isStale(ctx, telegramPostCard(backendDb, draftId)?.messageId);
}

/** Old video cards must not reschedule, cancel, or edit a video. Target retry is
 * state-guarded in the service because the same callback is also used by
 * standalone failure notifications. */
export function isStaleVideoCardCallback(ctx: Context, backendDb: BackendDb, data: string): boolean {
  const action = callbackAction(data);
  if (!VIDEO_CARD_ACTIONS.has(action)) return false;
  const draftId = Number(data.split(":").at(-1));
  if (!Number.isSafeInteger(draftId) || draftId <= 0) return false;
  return isStale(ctx, telegramVideoCard(backendDb, draftId)?.messageId);
}

function isStale(ctx: Context, currentMessageId: number | undefined): boolean {
  const callbackMessage = ctx.callbackQuery?.message;
  const messageId = callbackMessage && "message_id" in callbackMessage ? callbackMessage.message_id : null;
  return messageId != null && currentMessageId != null && messageId !== currentMessageId;
}
