import { isKnownTarget } from "../botTargets.js";
import { parseJsonValue } from "../json.js";

/** Reads the complete target map persisted by draft creation. */
export function parseTargets(value: unknown): Record<string, boolean> {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, enabled]) => [key, Boolean(enabled)]));
}

/** Unknown enabled keys must fail before a durable job can be materialized. */
export function assertKnownTargets(targets: Readonly<Record<string, boolean>>): void {
  const unknown = Object.entries(targets)
    .filter(([target, enabled]) => enabled && !isKnownTarget(target))
    .map(([target]) => target)
    .sort();
  if (unknown.length > 0) throw new Error(`Unknown publication target(s): ${unknown.join(", ")}`);
}
