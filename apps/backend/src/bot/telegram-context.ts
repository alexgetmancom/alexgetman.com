import type { Context } from "grammy";

/** Returns the message that carried the current callback, when there is one. */
export function callbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}
