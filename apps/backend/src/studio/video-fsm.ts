import type { VideoTarget } from "../publishing/video-types.js";

type VideoWizardStep = "youtube_title" | "youtube_description" | "youtube_game_url" | "youtube_tags" | "instagram_caption";
export type VideoPrompt = "youtube_title" | "youtube_description" | "youtube_game_url" | "youtube_tags" | "instagram_caption" | "schedule";
type VideoWizardData = Record<string, unknown>;

export function firstVideoMetadataStep(selected: VideoTarget[]): { step: VideoWizardStep; prompt: VideoPrompt } {
  return selected.includes("youtube_shorts")
    ? { step: "youtube_title", prompt: "youtube_title" }
    : { step: "instagram_caption", prompt: "instagram_caption" };
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
    return { data: { ...data, youtube_game_url: text === "-" ? "" : text }, nextStep: "youtube_tags", prompt: "youtube_tags" };
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
