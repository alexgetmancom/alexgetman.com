import type { Flow, FlowStep } from "../application/conversation-flow.js";
import { fixUrlSlashes } from "../content/message.js";
import { StudioError } from "../foundation/errors.js";
import { VIDEO_TARGETS, type VideoTarget } from "../publishing/video-types.js";

type VideoFlowData = Record<string, unknown> & { selectedTargets?: VideoTarget[] };

function defineVideoSteps<const TSteps extends Record<string, FlowStep<VideoFlowData>>>(steps: TSteps): TSteps {
  return steps;
}

const VIDEO_METADATA_STEP_NAMES = [
  "youtube_title",
  "youtube_description",
  "youtube_game_url",
  "youtube_tags",
  "instagram_caption",
] as const;

export type VideoWizardStep = (typeof VIDEO_METADATA_STEP_NAMES)[number];

const VIDEO_METADATA_STEPS = {
  youtube_title: {
    name: "youtube_title" as const,
    input: "text",
    next: () => "youtube_description" as const,
    accept: (input, data) => advanceVideoMetadata("youtube_title", String(input), data),
  },
  youtube_description: {
    name: "youtube_description" as const,
    input: "text",
    next: () => "youtube_game_url" as const,
    accept: (input, data) => advanceVideoMetadata("youtube_description", String(input), data),
    back: () => "youtube_title",
  },
  youtube_game_url: {
    name: "youtube_game_url" as const,
    input: "text",
    next: () => "youtube_tags" as const,
    accept: (input, data) => advanceVideoMetadata("youtube_game_url", String(input), data),
    back: () => "youtube_description",
  },
  youtube_tags: {
    name: "youtube_tags" as const,
    input: "text",
    next: (data) => (data.selectedTargets?.includes("instagram_reels") ? "instagram_caption" : "schedule_choice"),
    accept: (input, data) => advanceVideoMetadata("youtube_tags", String(input), data),
    back: () => "youtube_game_url",
  },
  instagram_caption: {
    name: "instagram_caption" as const,
    input: "text",
    next: () => "schedule_choice" as const,
    accept: (input, data) => advanceVideoMetadata("instagram_caption", String(input), data),
    back: (data) => (data.selectedTargets?.includes("youtube_shorts") ? "youtube_tags" : null),
  },
} satisfies Record<VideoWizardStep, FlowStep<VideoFlowData, unknown, never, VideoWizardStep | "schedule_choice">>;

const VIDEO_STEPS = defineVideoSteps({
  locale: { name: "locale" as const, next: () => "asset" as const, accept: (input, data) => ({ ...data, videoLocale: input }) },
  asset: {
    name: "asset" as const,
    input: "media",
    next: (data) => firstVideoMetadataStep(data.selectedTargets ?? []),
    accept: (input, data) => ({ ...data, assetId: input }),
  },
  label: { name: "label" as const, input: "text", next: () => "targets" as const, accept: (input, data) => ({ ...data, label: input }) },
  targets: {
    name: "targets" as const,
    next: (data) => firstVideoMetadataStep(data.selectedTargets ?? []),
    accept: (input, data) => ({ ...data, selectedTargets: input as VideoTarget[] }),
  },
  schedule_choice: {
    name: "schedule_choice" as const,
    next: (data) => (data.scheduleMode === "common" ? "schedule_common" : "schedule_target"),
    accept: (input, data) => ({ ...data, scheduleMode: input }),
  },
  schedule_common: {
    name: "schedule_common" as const,
    input: "text",
    next: () => "schedule_confirm" as const,
    // One typed or picked time answers for every selected platform at once, so
    // the step writes the whole schedule rather than a single value the caller
    // would have to fan out again.
    accept: (input, data) => ({
      ...data,
      schedule: isoSchedule(commonVideoSchedule(data.selectedTargets ?? [], new Date(String(input)))),
    }),
  },
  schedule_target: {
    name: "schedule_target" as const,
    input: "text",
    // Both the schedule and the platform still waiting for a time come from the
    // accumulated schedule itself. Nothing outside the step recomputes them.
    next: (data) => (pendingScheduleTarget(data.selectedTargets ?? [], currentSchedule(data)) ? "schedule_target" : "schedule_confirm"),
    accept: (input, data) => {
      const target = requireScheduleTarget(data);
      const { schedule, nextTarget } = advanceVideoTargetSchedule(
        data.selectedTargets ?? [],
        currentSchedule(data),
        target,
        new Date(String(input)),
      );
      return { ...data, schedule, ...(nextTarget ? { target: nextTarget } : {}) };
    },
  },
  schedule_confirm: { name: "schedule_confirm" as const, next: () => null },
  ...VIDEO_METADATA_STEPS,
});

export type VideoConversationStep = keyof typeof VIDEO_STEPS;

export function isVideoWizardStep(step: VideoConversationStep): step is VideoWizardStep {
  return VIDEO_METADATA_STEP_NAMES.some((name) => name === step);
}

/** The complete transport-neutral video workflow. Telegram renders step-specific questions separately. */
export const VIDEO_FLOW: Flow<VideoFlowData, unknown, never, VideoConversationStep> = {
  kind: "video",
  steps: VIDEO_STEPS,
};

export function firstVideoMetadataStep(selected: VideoTarget[]): VideoWizardStep {
  return selected.includes("youtube_shorts") ? "youtube_title" : "instagram_caption";
}

/** Pure metadata transition used by the video Flow and non-Telegram callers. */
export function advanceVideoMetadata(step: VideoWizardStep, text: string, data: VideoFlowData): VideoFlowData {
  if (step === "youtube_title") return { ...data, youtube_title: text };
  if (step === "youtube_description") return { ...data, youtube_description: text === "-" ? "" : text };
  if (step === "youtube_game_url") return { ...data, youtube_game_url: text === "-" ? "" : fixUrlSlashes(text) };
  if (step === "youtube_tags") {
    const tags =
      text === "-"
        ? []
        : text
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
    return { ...data, youtube_tags: tags };
  }
  return { ...data, instagram_caption: text === "-" ? "" : text };
}

/** Adds one parsed target time and names the platform still waiting for one. */
function advanceVideoTargetSchedule(
  selected: VideoTarget[],
  current: Record<string, string>,
  target: VideoTarget,
  value: Date,
): { schedule: Record<string, string>; nextTarget: VideoTarget | null } {
  const schedule = { ...current, [target]: value.toISOString() };
  return { schedule, nextTarget: pendingScheduleTarget(selected, schedule) };
}

function commonVideoSchedule(selected: VideoTarget[], value: Date): Partial<Record<VideoTarget, Date>> {
  return Object.fromEntries(selected.map((target) => [target, value])) as Partial<Record<VideoTarget, Date>>;
}

/** Reads the ISO schedule accumulated so far by the per-target chain. */
function currentSchedule(data: VideoFlowData): Record<string, string> {
  return (data.schedule as Record<string, string> | undefined) ?? {};
}

export function videoScheduleDates(schedule: Record<string, string>): Partial<Record<VideoTarget, Date>> {
  return Object.fromEntries(Object.entries(schedule).map(([target, value]) => [target, new Date(value)])) as Partial<
    Record<VideoTarget, Date>
  >;
}

function isoSchedule(schedule: Partial<Record<VideoTarget, Date>>): Record<string, string> {
  return Object.fromEntries(Object.entries(schedule).flatMap(([target, value]) => (value ? [[target, value.toISOString()]] : [])));
}

function pendingScheduleTarget(selected: VideoTarget[], schedule: Record<string, string>): VideoTarget | null {
  return selected.find((target) => !schedule[target]) ?? null;
}

function requireScheduleTarget(data: VideoFlowData): VideoTarget {
  const target = data.target;
  if (
    typeof target !== "string" ||
    !VIDEO_TARGETS.includes(target as VideoTarget) ||
    !data.selectedTargets?.includes(target as VideoTarget)
  )
    throw new StudioError("err.video-reopen-publish");
  return target as VideoTarget;
}
