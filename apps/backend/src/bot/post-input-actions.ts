import type { Context } from "grammy";
import { acceptFlow } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { requireConversationState } from "./conversation-state.js";
import type { PublicationEffect } from "./effects.js";
import { extractMessage } from "./message.js";
import type { PostFlowInput, PostWizardStep } from "./post-flow-types.js";
import { POST_FLOW } from "./post-fsm.js";
import { renderPublicationCard } from "./publication-card.js";
import { publicationCardEffect } from "./publication-card-effects.js";

export async function applyAdminState(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  step: PostWizardStep,
  draftId: number,
  controlMessageId: number | null,
  expectedRevision?: number | null,
): Promise<PublicationEffect[]> {
  const actorId = Number(ctx.from?.id);
  if (expectedRevision != null) requireConversationState(backendDb, actorId, "post", expectedRevision);
  const message = extractMessage(ctx);
  const input: PostFlowInput = { backendDb, config, actorId, draftId, controlMessageId, step, message };
  const transition = await acceptFlow(POST_FLOW, step.type, input, {});
  if (!transition) throw new StudioError("action.session-stale");
  if (transition.next === null) {
    const preview = renderPublicationCard("post", { backendDb, config, publicationId: draftId });
    return [
      ...transition.effects,
      { type: "session", operation: "clear", kind: "post", actorId },
      ...publicationCardEffect("post", draftId, preview, { type: "prompt" }),
    ];
  }
  return [...transition.effects];
}
