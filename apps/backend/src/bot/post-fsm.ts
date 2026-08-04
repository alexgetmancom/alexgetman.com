import type { Flow, FlowStep } from "../application/conversation-flow.js";

type PostWizardLocale = "ru" | "en";

/** The short names persisted in conversation_sessions.step. */
export type PostSessionStep = "new_post" | "edit_sources" | "edit_text" | "replace_media" | "schedule_manual" | "schedule_confirm";

export type PostWizardStep =
  | { type: "new_post" }
  | { type: "edit_sources" }
  | { type: "edit_text"; locale: PostWizardLocale }
  | { type: "replace_media"; locale: PostWizardLocale }
  | { type: "schedule_manual"; locale: PostWizardLocale }
  | { type: "schedule_confirm"; locale: PostWizardLocale; value: Date };

export type PostWizardStepInput = PostWizardStep | string | null;

const POST_STEPS: Record<string, FlowStep<Record<string, unknown>>> = Object.fromEntries(
  (["new_post", "edit_sources", "edit_text", "replace_media", "schedule_manual", "schedule_confirm"] as const).map((name) => [
    name,
    { name, prompt: () => null, next: () => null },
  ]),
);

/** State-only post flow. Telegram screens remain in post-screen and post-actions. */
export const POST_FLOW: Flow<Record<string, unknown>> = {
  kind: "post",
  steps: POST_STEPS,
};

/** Resolves both the current short-step form and the legacy 30-minute form. */
export function resolvePostWizardStep(value: PostWizardStepInput, data: Record<string, unknown> = {}): PostWizardStep | null {
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
  if (value === "edit_ru") return { type: "edit_text", locale: "ru" };
  if (value === "edit_en") return { type: "edit_text", locale: "en" };
  if (value === "replace_ru_media") return { type: "replace_media", locale: "ru" };
  if (value === "replace_en_media") return { type: "replace_media", locale: "en" };

  const manualMatch = value?.match(/^schedule_manual_(ru|en)$/);
  if (manualMatch) return { type: "schedule_manual", locale: manualMatch[1] as PostWizardLocale };

  const confirmMatch = value?.match(/^schedule_confirm_(ru|en)_(.+)$/);
  if (!confirmMatch) return null;
  const date = parseDate(confirmMatch[2]);
  return date ? { type: "schedule_confirm", locale: confirmMatch[1] as PostWizardLocale, value: date } : null;
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

/** Keeps the old action value at the adapter boundary for pending albums. */
export function postStepAction(step: PostWizardStep): string {
  if (step.type === "new_post" || step.type === "edit_sources") return step.type;
  if (step.type === "edit_text") return `edit_${step.locale}`;
  if (step.type === "replace_media") return `replace_${step.locale}_media`;
  if (step.type === "schedule_manual") return `schedule_manual_${step.locale}`;
  return `schedule_confirm_${step.locale}_${step.value.toISOString()}`;
}

export function isPostInputStep(step: PostWizardStep | null): boolean {
  return step?.type === "edit_sources" || step?.type === "edit_text" || step?.type === "replace_media" || step?.type === "schedule_manual";
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
