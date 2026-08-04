import type { Context } from "grammy";
import { acceptFlow, type Flow, type FlowStep } from "../application/conversation-flow.js";
import type { DraftMessage } from "../content/message.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { ConversationState } from "./conversation-state.js";
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
  ctx: Context;
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  draftId: number;
  controlMessageId: number | null;
  step: PostWizardStep;
  message: DraftMessage;
};
export type PostWizardStepInput = PostWizardStep | PostSessionStep | null;

function postStep(
  name: PostSessionStep,
  next: (data: PostFlowData) => string | null,
  accept?: (input: PostFlowInput, data: PostFlowData) => PostFlowData | Promise<PostFlowData>,
): FlowStep<PostFlowData, PostFlowInput> {
  return { name, next, ...(accept ? { accept } : {}) };
}

const POST_STEPS: Record<string, FlowStep<PostFlowData, PostFlowInput>> = {
  new_post: postStep(
    "new_post",
    () => null,
    (input, data) => ({ ...data, input: input.message }),
  ),
  edit_sources: postStep("edit_sources", () => null, acceptPostSourceEdit),
  edit_text: postStep("edit_text", () => null, acceptPostTextEdit),
  replace_media: postStep("replace_media", () => null, acceptPostMediaReplacement),
  schedule_manual: postStep("schedule_manual", () => "schedule_confirm", acceptManualPostSchedule),
  schedule_confirm: postStep("schedule_confirm", () => null),
};

/** The complete post workflow, including input effects and transitions. */
export const POST_FLOW: Flow<PostFlowData, PostFlowInput> = {
  kind: "post",
  steps: POST_STEPS,
};

export function resolvePostWizardStep(value: PostWizardStepInput | string, data: Record<string, unknown> = {}): PostWizardStep | null {
  if (value && typeof value === "object") return value;
  if (value === "new_post") return { type: "new_post" };
  if (value === "edit_sources") return { type: "edit_sources" };
  if (value === "edit_text") return localeStep("edit_text", data.locale);
  if (value === "replace_media") return localeStep("replace_media", data.locale);
  if (value === "schedule_manual") return localeStep("schedule_manual", data.locale);
  if (value === "schedule_confirm") {
    const locale = parseLocale(data.locale);
    const date = parseDate(data.value);
    return locale && date ? { type: "schedule_confirm", locale, value: date } : null;
  }
  return null;
}

/** Returns the short database value for a typed post step. */
export function postStepName(step: PostWizardStep): PostSessionStep {
  const flowStep = POST_FLOW.steps[step.type];
  if (!flowStep) throw new Error(`Unknown post flow step: ${step.type}`);
  return flowStep.name as PostSessionStep;
}

/** Returns the parameter payload stored beside the short step name. */
export function postStepData(step: PostWizardStep): Record<string, unknown> {
  if (step.type === "edit_text" || step.type === "replace_media" || step.type === "schedule_manual") return { locale: step.locale };
  if (step.type === "schedule_confirm") return { locale: step.locale, value: step.value.toISOString() };
  return {};
}

/** Compact value used by the durable album handoff. */
export function serializePostWizardStep(step: PostWizardStep | null): string | null {
  if (!step) return null;
  if (step.type === "edit_text" || step.type === "replace_media" || step.type === "schedule_manual") return `${step.type}:${step.locale}`;
  if (step.type === "schedule_confirm") return `${step.type}:${step.locale}`;
  return step.type;
}

/** Parses the typed step stored beside a pending album. */
export function parsePostWizardStep(value: string | null): PostWizardStep | null {
  if (!value) return null;
  const [type, locale] = value.split(":");
  if (type === "new_post") return { type };
  if (type === "edit_sources") return { type };
  if (type === "edit_text" || type === "replace_media" || type === "schedule_manual") {
    return locale === "ru" || locale === "en" ? { type, locale } : null;
  }
  return null;
}

export function isPostInputStep(step: PostWizardStep | null): boolean {
  return step?.type === "edit_sources" || step?.type === "edit_text" || step?.type === "replace_media" || step?.type === "schedule_manual";
}

export function postStateStep(state: Pick<ConversationState, "step" | "data"> | null): PostWizardStep | null {
  return state ? resolvePostWizardStep(state.step, state.data) : null;
}

export function acceptPostFlowStep(
  step: PostWizardStep,
  input: PostFlowInput,
  data: PostFlowData,
): Promise<{ data: PostFlowData; next: string | null } | null> {
  return acceptFlow(POST_FLOW, step.type, input, data);
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
