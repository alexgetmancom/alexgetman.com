import { DEFAULT_TARGETS, isKnownTarget } from "../botTargets.js";
import { parseJsonValue } from "../json.js";

/**
 * Normalizes a persisted post-target map at the publishing boundary.
 * Interfaces may display or edit targets, but must not need to know the
 * fallback contract for old or malformed draft records.
 */
export function parseTargets(value: unknown): Record<string, boolean> {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_TARGETS };
  return {
    ...DEFAULT_TARGETS,
    ...Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, enabled]) => [key, Boolean(enabled)])),
  };
}

/** Site jobs are keyed by a publish reason while everything else speaks in
 * targets, so the two names for one locale meet here rather than in each caller.
 * Three identical copies of this had accumulated across publishing, persistence
 * and the Telegram notifier. */
export function siteTargetForReason(reason: string): "site_ru" | "site_en" | null {
  if (reason === "publish_ru") return "site_ru";
  if (reason === "publish_en") return "site_en";
  return null;
}

export function siteReasonForTarget(target: string): "publish_ru" | "publish_en" | null {
  if (target === "site_ru") return "publish_ru";
  if (target === "site_en") return "publish_en";
  return null;
}

/** Unknown enabled keys must fail before a durable job can be materialized. */
export function assertKnownTargets(targets: Readonly<Record<string, boolean>>): void {
  const unknown = Object.entries(targets)
    .filter(([target, enabled]) => enabled && !isKnownTarget(target))
    .map(([target]) => target)
    .sort();
  if (unknown.length > 0) throw new Error(`Unknown publication target(s): ${unknown.join(", ")}`);
}
