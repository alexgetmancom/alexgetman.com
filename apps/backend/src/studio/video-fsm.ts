import type { Flow, FlowStep } from "../application/conversation-flow.js";
import { fixUrlSlashes } from "../content/message.js";
import type { VideoTarget } from "../publishing/video-types.js";

export type VideoWizardStep = "youtube_title" | "youtube_description" | "youtube_game_url" | "youtube_tags" | "instagram_caption";
export type VideoFlowData = Record<string, unknown> & { selectedTargets?: VideoTarget[]; nextTarget?: VideoTarget | null };

const VIDEO_STEPS: Record<string, FlowStep<VideoFlowData>> = {
  locale: { name: "locale", next: () => "asset", accept: (input, data) => ({ ...data, videoLocale: input }) },
  asset: {
    name: "asset",
    next: (data) => (data.selectedTargets?.includes("youtube_shorts") ? "youtube_title" : "instagram_caption"),
    accept: (input, data) => ({ ...data, assetId: input }),
  },
  label: { name: "label", next: () => "targets", accept: (input, data) => ({ ...data, label: input }) },
  targets: {
    name: "targets",
    next: (data) => (data.selectedTargets?.includes("youtube_shorts") ? "youtube_title" : "instagram_caption"),
    accept: (input, data) => ({ ...data, selectedTargets: input as VideoTarget[] }),
  },
  schedule_choice: {
    name: "schedule_choice",
    next: (data) => (data.scheduleMode === "common" ? "schedule_common" : "schedule_target"),
    accept: (input, data) => ({ ...data, scheduleMode: input }),
  },
  schedule_common: {
    name: "schedule_common",
    next: () => "schedule_confirm",
    accept: (input, data) => ({ ...data, scheduleValue: input }),
  },
  schedule_target: {
    name: "schedule_target",
    next: (data) => (data.nextTarget ? "schedule_target" : "schedule_confirm"),
    accept: (input, data) => ({ ...data, scheduleValue: input }),
  },
  schedule_confirm: { name: "schedule_confirm", next: () => null, accept: (_input, data) => data },
  youtube_title: {
    name: "youtube_title",
    next: () => "youtube_description",
    accept: (input, data) => advanceVideoMetadata("youtube_title", String(input), data).data,
  },
  youtube_description: {
    name: "youtube_description",
    next: () => "youtube_game_url",
    accept: (input, data) => advanceVideoMetadata("youtube_description", String(input), data).data,
    back: () => "youtube_title",
  },
  youtube_game_url: {
    name: "youtube_game_url",
    next: () => "youtube_tags",
    accept: (input, data) => advanceVideoMetadata("youtube_game_url", String(input), data).data,
    back: () => "youtube_description",
  },
  youtube_tags: {
    name: "youtube_tags",
    next: (data) => (data.selectedTargets?.includes("instagram_reels") ? "instagram_caption" : "schedule_choice"),
    accept: (input, data) => advanceVideoMetadata("youtube_tags", String(input), data).data,
    back: () => "youtube_game_url",
  },
  instagram_caption: {
    name: "instagram_caption",
    next: () => "schedule_choice",
    accept: (input, data) => advanceVideoMetadata("instagram_caption", String(input), data).data,
    back: (data) => (data.selectedTargets?.includes("youtube_shorts") ? "youtube_tags" : null),
  },
};

/** The complete transport-neutral video workflow. Telegram renders step-specific questions separately. */
export const VIDEO_FLOW: Flow<VideoFlowData> = {
  kind: "video",
  steps: VIDEO_STEPS,
};

export function firstVideoMetadataStep(selected: VideoTarget[]): VideoWizardStep {
  return selected.includes("youtube_shorts") ? "youtube_title" : "instagram_caption";
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
): { data: VideoFlowData; nextStep: VideoWizardStep | null } {
  if (step === "youtube_title") return { data: { ...data, youtube_title: text }, nextStep: "youtube_description" };
  if (step === "youtube_description")
    return { data: { ...data, youtube_description: text === "-" ? "" : text }, nextStep: "youtube_game_url" };
  if (step === "youtube_game_url")
    return {
      data: { ...data, youtube_game_url: text === "-" ? "" : fixUrlSlashes(text) },
      nextStep: "youtube_tags",
    };
  if (step === "youtube_tags") {
    const tags =
      text === "-"
        ? []
        : text
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
    return { data: { ...data, youtube_tags: tags }, nextStep: null };
  }
  return { data: { ...data, instagram_caption: text === "-" ? "" : text }, nextStep: null };
}

/** Chooses the next metadata or scheduling state without knowing about Telegram controls. */
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
