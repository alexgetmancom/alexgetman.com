import { platformProfile } from "./platform-profiles.js";

/** A read-only projection of the delivery contract declared in platform profiles. */
type MediaPolicy = {
  target: string;
  inputCount: number;
  deliveredCount: number;
  mode: "all" | "limited" | "first" | "story-first";
  note: string | null;
};

export function mediaPolicyForTarget(target: string, media: unknown[]): MediaPolicy {
  const inputCount = media.length;
  const first = (mode: MediaPolicy["mode"], note: string): MediaPolicy => ({
    target,
    inputCount,
    deliveredCount: Math.min(inputCount, 1),
    mode,
    note: inputCount > 1 ? note : null,
  });
  const limited = (limit: number, label: string): MediaPolicy => ({
    target,
    inputCount,
    deliveredCount: Math.min(inputCount, limit),
    mode: inputCount > limit ? "limited" : "all",
    note: inputCount > limit ? `${label} receives at most ${limit} media items.` : null,
  });

  const rule = mediaRuleForTarget(target);
  if (!rule) return all(target, inputCount);
  const selected = rule.whenVideo && media.some(isVideo) ? rule.whenVideo : rule;
  switch (selected.mode) {
    case "limited":
      return limited(selected.limit, selected.label);
    case "first":
    case "story-first":
      return first(selected.mode, selected.note);
    default:
      return all(target, inputCount);
  }
}

/** Applies the same target policy used by previews to the durable delivery payload. */
export function selectMediaForTarget<T>(target: string, media: readonly T[]): T[] {
  const rule = mediaRuleForTarget(target);
  const selected = rule?.whenVideo && media.some(isVideo) ? rule.whenVideo : rule;
  if (!selected) return [...media];
  if (selected.mode === "limited") return [...media].slice(0, selected.limit);
  if (selected.mode === "first" || selected.mode === "story-first") return [...media].slice(0, 1);
  return [...media];
}

function mediaRuleForTarget(target: string) {
  return platformProfile(target)?.media;
}

function all(target: string, inputCount: number): MediaPolicy {
  return { target, inputCount, deliveredCount: inputCount, mode: "all", note: null };
}

function isVideo(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const value = item as Record<string, unknown>;
  return String(value.type ?? value.media_type ?? "").toLowerCase() === "video";
}
