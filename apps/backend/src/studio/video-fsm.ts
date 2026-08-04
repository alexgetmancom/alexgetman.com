import type { Flow, FlowStep } from "../application/conversation-flow.js";
import { fixUrlSlashes } from "../content/message.js";
import type { VideoTarget } from "../publishing/video-types.js";

export type VideoWizardStep = "youtube_title" | "youtube_description" | "youtube_game_url" | "youtube_tags" | "instagram_caption";
export type VideoPrompt = "youtube_title" | "youtube_description" | "youtube_game_url" | "youtube_tags" | "instagram_caption" | "schedule";
type VideoWizardData = Record<string, unknown>;

const VIDEO_STEPS: Record<string, FlowStep<VideoWizardData>> = Object.fromEntries(
  (
    [
      "locale",
      "asset",
      "targets",
      "schedule_choice",
      "schedule_common",
      "schedule_target",
      "schedule_confirm",
      "label",
      "youtube_title",
      "youtube_description",
      "youtube_game_url",
      "youtube_tags",
      "instagram_caption",
    ] as const
  ).map((name) => [name, { name, prompt: () => null, next: () => null }]),
);

/** State-only video flow; Telegram prompt rendering stays in the bot adapter. */
export const VIDEO_FLOW: Flow<VideoWizardData> = {
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
  if (step === "youtube_description") return "youtube_title";
  if (step === "youtube_game_url") return "youtube_description";
  if (step === "youtube_tags") return "youtube_game_url";
  if (step === "instagram_caption") return selected.includes("youtube_shorts") ? "youtube_tags" : null;
  return null;
}

/** Pure conversation state machine. Persistence and Telegram rendering remain adapters. */
export function advanceVideoMetadata(
  step: VideoWizardStep,
  text: string,
  data: VideoWizardData,
): { data: VideoWizardData; nextStep: VideoWizardStep | null; prompt: VideoPrompt } {
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
  return selected.includes("instagram_reels") ? "instagram_caption" : "schedule_choice";
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
