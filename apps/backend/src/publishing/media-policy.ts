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

  const rule = platformProfile(target)?.media;
  if (!rule) return all(target, inputCount);
  const selected = rule.whenVideo && media.some(isVideo) ? rule.whenVideo : rule;
  if (selected.mode === "limited" && selected.limit && selected.label) return limited(selected.limit, selected.label);
  if ((selected.mode === "first" || selected.mode === "story-first") && selected.note) return first(selected.mode, selected.note);
  return all(target, inputCount);
}

function all(target: string, inputCount: number): MediaPolicy {
  return { target, inputCount, deliveredCount: inputCount, mode: "all", note: null };
}

function isVideo(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const value = item as Record<string, unknown>;
  return String(value.type ?? value.media_type ?? "").toLowerCase() === "video";
}
