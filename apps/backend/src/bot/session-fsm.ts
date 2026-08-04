import { StudioError } from "../foundation/errors.js";

const SESSION_VERSION_PATTERN = /^sv(\d+)$/;

export type SessionCallback = { data: string; revision: number | null };

/** Appends a monotonically increasing dialog revision to a callback payload. */
export function versionedCallback(data: string, revision: number | null | undefined): string {
  return revision == null ? data : `${data}:sv${revision}`;
}

/** Separates the optional revision suffix without making individual handlers
 * know how Telegram transport metadata is encoded. */
export function parseSessionCallback(data: string): SessionCallback {
  const parts = data.split(":");
  const suffix = parts.at(-1) ?? "";
  const match = suffix.match(SESSION_VERSION_PATTERN);
  if (!match) return { data, revision: null };
  return { data: parts.slice(0, -1).join(":"), revision: Number(match[1]) };
}

/** Rejects a callback or write based on an older dialog generation. */
export function requireSessionRevision(current: number | undefined, expected: number | null, errorCode = "action.session-stale"): void {
  if (expected != null && current !== expected) throw new StudioError(errorCode);
}

/** Shared transition guard for every conversational FSM. */
export function requireSessionStep(current: string | undefined, allowed: readonly string[], errorCode: string): void {
  if (!current || !allowed.includes(current)) throw new StudioError(errorCode);
}
