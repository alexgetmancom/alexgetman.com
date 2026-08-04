import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { telegramPostCard, telegramVideoCard } from "../interfaces/telegram/control-cards.js";

const POST_CARD_ACTIONS = new Set([
  "toggle",
  "cycle_mode",
  "sources",
  "edit_ru",
  "edit_en",
  "replace_ru_media",
  "replace_en_media",
  "cancel",
  "cancel_confirm",
  "post_retry",
  "publish",
  "publish_confirm",
  "schedule",
  "sched_scope",
  "sched_view",
  "sched_pick",
  "sched_manual",
  "story_publish_all",
  "story_publish_site",
  "story_schedule_all",
  "story_schedule_site",
]);

const VIDEO_CARD_ACTIONS = new Set([
  "video_schedule_confirm",
  "video_schedule",
  "video_common",
  "video_individual",
  "video_now",
  "video_now_confirm",
  "video_cancel_ask",
  "video_remove_ask",
  "video_cancel",
  "video_time",
  "video_sched_pick",
  "video_sched_manual",
  "video_remove",
  "video_edit_menu",
  "video_edit_field",
  "video_edit",
]);

/** Old post cards must not mutate a draft after a newer card has replaced them. */
export function isStalePostCardCallback(ctx: Context, backendDb: BackendDb, action: string, draftId: number): boolean {
  if (!POST_CARD_ACTIONS.has(action)) return false;
  return isStale(ctx, telegramPostCard(backendDb, draftId)?.messageId);
}

/** Old video cards must not reschedule, cancel, or edit a video. Target retry is
 * state-guarded in the service because the same callback is also used by
 * standalone failure notifications. */
export function isStaleVideoCardCallback(ctx: Context, backendDb: BackendDb, data: string): boolean {
  const action = data.split(":")[0] ?? "";
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
