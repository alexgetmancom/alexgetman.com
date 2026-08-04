import type { Flow, FlowStep } from "../application/conversation-flow.js";
import type { DraftMessage } from "../content/message.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { ConversationState } from "./conversation-state.js";
import type { PublicationEffect } from "./effects.js";
import { acceptManualPostSchedule, acceptPostMediaReplacement, acceptPostSourceEdit, acceptPostTextEdit } from "./post-flow-actions.js";

export type PostWizardLocale = "ru" | "en";

/** The short names persisted in conversation_sessions.step. */
export type PostSessionStep = "new_post" | "edit_sources" | "edit_text" | "replace_media" | "schedule_manual" | "schedule_confirm";

export type PostWizardStep =
  | { type: "new_post" }
  | { type: "edit_sources" }
  | { type: "edit_text"; locale: PostWizardLocale }
  | { type: "replace_media"; locale: PostWizardLocale }
  | { type: "schedule_manual"; locale: PostWizardLocale }
  | { type: "schedule_confirm"; locale: PostWizardLocale; value: Date };

export type PostFlowData = Record<string, unknown>;
export type PostFlowInput = {
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  draftId: number;
  controlMessageId: number | null;
  step: PostWizardStep;
  message: DraftMessage;
};

const POST_STEPS: Record<string, FlowStep<PostFlowData, PostFlowInput, PublicationEffect>> = {
  new_post: {
    name: "new_post",
    next: () => null,
    accept: (input, data) => ({ ...data, input: input.message }),
  },
  edit_sources: { name: "edit_sources", next: () => null, accept: acceptPostSourceEdit },
  edit_text: { name: "edit_text", next: () => null, accept: acceptPostTextEdit },
  replace_media: { name: "replace_media", next: () => null, accept: acceptPostMediaReplacement },
  schedule_manual: { name: "schedule_manual", next: () => "schedule_confirm", accept: acceptManualPostSchedule },
  schedule_confirm: { name: "schedule_confirm", next: () => null },
};

/** The complete post workflow, including input effects and transitions. */
export const POST_FLOW: Flow<PostFlowData, PostFlowInput, PublicationEffect> = {
  kind: "post",
  steps: POST_STEPS,
};

export function isPostInputStep(step: PostWizardStep | null): boolean {
  return step?.type === "edit_sources" || step?.type === "edit_text" || step?.type === "replace_media" || step?.type === "schedule_manual";
}

export function postStateStep(state: Pick<ConversationState, "step" | "data"> | null): PostWizardStep | null {
  if (!state) return null;
  if (state.step === "new_post") return { type: "new_post" };
  if (state.step === "edit_sources") return { type: "edit_sources" };
  if (state.step === "edit_text") return localeStep("edit_text", state.data.locale);
  if (state.step === "replace_media") return localeStep("replace_media", state.data.locale);
  if (state.step === "schedule_manual") return localeStep("schedule_manual", state.data.locale);
  if (state.step === "schedule_confirm") {
    const locale = parseLocale(state.data.locale);
    const date = parseDate(state.data.value);
    return locale && date ? { type: "schedule_confirm", locale, value: date } : null;
  }
  return null;
}

function localeStep(type: "edit_text" | "replace_media" | "schedule_manual", value: unknown): PostWizardStep | null {
  const locale = parseLocale(value);
  return locale ? { type, locale } : null;
}

function parseLocale(value: unknown): PostWizardLocale | null {
  return value === "ru" || value === "en" ? value : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
