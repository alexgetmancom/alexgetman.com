import type { Context } from "grammy";
import { withActionLock } from "../foundation/action-lock.js";

/** Runs a callback mutation once and acknowledges a duplicate tap locally. */
export async function withCallbackActionLock<T>(
  ctx: Context,
  key: string,
  action: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const result = await withActionLock(key, action);
  if (!result.ok) await ctx.answerCallbackQuery();
  return result;
}
