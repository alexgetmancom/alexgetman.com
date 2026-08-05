import { acceptFlow } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import { StudioError } from "../foundation/errors.js";
import { VIDEO_FLOW, type VideoConversationStep } from "../studio/video-fsm.js";
import { saveVideoState, type VideoConversationState } from "./video-ui.js";

/** Advances one video FSM step and persists exactly one new session revision. */
export async function advanceVideoFlow(
  backendDb: BackendDb,
  actorId: number,
  session: VideoConversationState,
  step: VideoConversationStep,
  input: unknown,
  errorCode: string,
  decorateData?: (data: Record<string, unknown>, nextStep: VideoConversationStep) => Record<string, unknown>,
): Promise<VideoConversationState> {
  const transition = await acceptFlow(VIDEO_FLOW, step, input, { ...session.data, selectedTargets: session.selected });
  if (!transition?.next) throw new StudioError(errorCode);
  const nextStep = transition.next;
  const data = decorateData ? decorateData(transition.data, nextStep) : transition.data;
  return saveVideoState(backendDb, actorId, { ...session, step: nextStep, data });
}
