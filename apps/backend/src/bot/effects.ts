import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { ConversationStateInput } from "./conversation-state.js";
import { clearConversationState, saveConversationState } from "./conversation-state.js";

/** Effects emitted by publication handlers and interpreted by one Telegram executor. */
export type PublicationEffect =
  | { type: "answer-callback"; text?: string; showAlert?: boolean }
  | { type: "toast"; text: string; showAlert?: boolean }
  | { type: "screen"; mode: "edit" | "reply"; text: string; options?: Record<string, unknown> }
  | { type: "prompt"; text: string; options?: Record<string, unknown> }
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
      if (mode === "edit") await ctx.editMessageText(effect.text, effect.options);
      else await ctx.reply(effect.text, effect.options);
      continue;
    }
    if (effect.operation === "clear") {
      clearConversationState(backendDb, effect.actorId, effect.kind);
    } else {
      saveConversationState(backendDb, effect.actorId, effect.state);
    }
  }
}
