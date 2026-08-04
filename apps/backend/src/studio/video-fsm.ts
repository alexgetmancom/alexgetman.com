import { acceptFlow, type Flow, type FlowStep } from "../application/conversation-flow.js";
import { fixUrlSlashes } from "../content/message.js";
import type { VideoTarget } from "../publishing/video-types.js";

export type VideoWizardStep = "youtube_title" | "youtube_description" | "youtube_game_url" | "youtube_tags" | "instagram_caption";
export type VideoPrompt = "youtube_title" | "youtube_description" | "youtube_game_url" | "youtube_tags" | "instagram_caption" | "schedule";
export type VideoFlowData = Record<string, unknown> & { selectedTargets?: VideoTarget[]; nextTarget?: VideoTarget | null };

function videoStep(
  name: string,
  next: (data: VideoFlowData) => string | null,
  accept?: (input: unknown, data: VideoFlowData) => VideoFlowData,
  back?: (data: VideoFlowData) => string | null,
): FlowStep<VideoFlowData, unknown, string> {
  return { name, prompt: () => name, next, ...(accept ? { accept } : {}), ...(back ? { back } : {}) };
}

const VIDEO_STEPS: Record<string, FlowStep<VideoFlowData, unknown, string>> = {
  locale: videoStep(
    "locale",
    () => "asset",
    (input, data) => ({ ...data, videoLocale: input }),
  ),
  asset: videoStep(
    "asset",
    (data) => (data.selectedTargets?.includes("youtube_shorts") ? "youtube_title" : "instagram_caption"),
    (input, data) => ({ ...data, assetId: input }),
  ),
  label: videoStep(
    "label",
    () => "targets",
    (input, data) => ({ ...data, label: input }),
  ),
  targets: videoStep(
    "targets",
    (data) => (data.selectedTargets?.includes("youtube_shorts") ? "youtube_title" : "instagram_caption"),
    (input, data) => ({ ...data, selectedTargets: input as VideoTarget[] }),
  ),
  schedule_choice: videoStep(
    "schedule_choice",
    (data) => (data.scheduleMode === "common" ? "schedule_common" : "schedule_target"),
    (input, data) => ({ ...data, scheduleMode: input }),
  ),
  schedule_common: videoStep(
    "schedule_common",
    () => "schedule_confirm",
    (input, data) => ({ ...data, scheduleValue: input }),
  ),
  schedule_target: videoStep(
    "schedule_target",
    (data) => (data.nextTarget ? "schedule_target" : "schedule_confirm"),
    (input, data) => ({ ...data, scheduleValue: input }),
  ),
  schedule_confirm: videoStep(
    "schedule_confirm",
    () => null,
    (_input, data) => data,
  ),
  youtube_title: videoStep(
    "youtube_title",
    () => "youtube_description",
    (input, data) => advanceVideoMetadata("youtube_title", String(input), data).data,
  ),
  youtube_description: videoStep(
    "youtube_description",
    () => "youtube_game_url",
    (input, data) => advanceVideoMetadata("youtube_description", String(input), data).data,
    () => "youtube_title",
  ),
  youtube_game_url: videoStep(
    "youtube_game_url",
    () => "youtube_tags",
    (input, data) => advanceVideoMetadata("youtube_game_url", String(input), data).data,
    () => "youtube_description",
  ),
  youtube_tags: videoStep(
    "youtube_tags",
    (data) => (data.selectedTargets?.includes("instagram_reels") ? "instagram_caption" : "schedule_choice"),
    (input, data) => advanceVideoMetadata("youtube_tags", String(input), data).data,
    () => "youtube_game_url",
  ),
  instagram_caption: videoStep(
    "instagram_caption",
    () => "schedule_choice",
    (input, data) => advanceVideoMetadata("instagram_caption", String(input), data).data,
    (data) => (data.selectedTargets?.includes("youtube_shorts") ? "youtube_tags" : null),
  ),
};

/** The complete transport-neutral video workflow. Telegram only renders its prompt names. */
export const VIDEO_FLOW: Flow<VideoFlowData, unknown, string> = {
  kind: "video",
  steps: VIDEO_STEPS,
};

export function firstVideoMetadataStep(selected: VideoTarget[]): { step: VideoWizardStep; prompt: VideoPrompt } {
  return selected.includes("youtube_shorts")
    ? { step: "youtube_title", prompt: "youtube_title" }
    : { step: "instagram_caption", prompt: "instagram_caption" };
}

/** The step a "← Back" tap returns to, or null if the current step is the
 * first one in the metadata chain (nothing earlier to revisit). Mirrors
 * advanceVideoMetadata's forward transitions in reverse. */
export function previousVideoMetadataStep(step: VideoWizardStep, selected: VideoTarget[]): VideoWizardStep | null {
  const previous = VIDEO_FLOW.steps[step]?.back?.({ selectedTargets: selected });
  return (previous as VideoWizardStep | null | undefined) ?? null;
}

/** Pure metadata transition used by the video Flow and non-Telegram callers. */
export function advanceVideoMetadata(
  step: VideoWizardStep,
  text: string,
  data: VideoFlowData,
): { data: VideoFlowData; nextStep: VideoWizardStep | null; prompt: VideoPrompt } {
  if (step === "youtube_title")
    return { data: { ...data, youtube_title: text }, nextStep: "youtube_description", prompt: "youtube_description" };
  if (step === "youtube_description")
    return { data: { ...data, youtube_description: text === "-" ? "" : text }, nextStep: "youtube_game_url", prompt: "youtube_game_url" };
  if (step === "youtube_game_url")
    return {
      data: { ...data, youtube_game_url: text === "-" ? "" : fixUrlSlashes(text) },
      nextStep: "youtube_tags",
      prompt: "youtube_tags",
    };
  if (step === "youtube_tags") {
    const tags =
      text === "-"
        ? []
        : text
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
    return { data: { ...data, youtube_tags: tags }, nextStep: null, prompt: "schedule" };
  }
  return { data: { ...data, instagram_caption: text === "-" ? "" : text }, nextStep: null, prompt: "schedule" };
}

/** Chooses the next metadata or scheduling state without knowing about Telegram controls. */
export function nextVideoFlowStep(selected: VideoTarget[]): "instagram_caption" | "schedule_choice" {
  const next = VIDEO_FLOW.steps.youtube_tags?.next({ selectedTargets: selected });
  return next === "instagram_caption" ? next : "schedule_choice";
}

/** Executes a metadata step through the shared Flow runtime. */
export function acceptVideoFlowStep(
  step: string,
  input: unknown,
  data: VideoFlowData,
): { data: VideoFlowData; next: string | null } | null {
  return acceptFlow(VIDEO_FLOW, step, input, data);
}

/** Adds one parsed target time and chooses either the next target prompt or confirmation. */
export function advanceVideoTargetSchedule(
  selected: VideoTarget[],
  current: Record<string, string>,
  target: VideoTarget,
  value: Date,
): { schedule: Record<string, string>; nextTarget: VideoTarget | null } {
  const schedule = { ...current, [target]: value.toISOString() };
  return { schedule, nextTarget: selected.find((item) => !schedule[item]) ?? null };
}

export function commonVideoSchedule(selected: VideoTarget[], value: Date): Partial<Record<VideoTarget, Date>> {
  return Object.fromEntries(selected.map((target) => [target, value])) as Partial<Record<VideoTarget, Date>>;
}
