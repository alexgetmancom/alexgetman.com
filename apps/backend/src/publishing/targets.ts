import { DEFAULT_TARGETS } from "../botTargets.js";
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
