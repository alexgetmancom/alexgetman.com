import type { PublicationKind } from "../application/conversation-flow.js";
import { StudioError } from "../foundation/errors.js";

export type { PublicationKind } from "../application/conversation-flow.js";

const SESSION_VERSION_PREFIX = /^sv(\d+)\|(.*)$/;
const PUBLICATION_CALLBACK = /^p:(post|video):([^:]+)(?::(.*))?$/;

export type PublicationCallback = {
  kind: PublicationKind;
  action: string;
  args: string[];
};

export type SessionCallback = {
  data: string;
  callback: PublicationCallback | null;
  revision: number | null;
};

/** Builds the compact callback namespace shared by post and video controls. */
export function publicationCallback(
  kind: PublicationKind,
  action: string,
  args: readonly (string | number)[] = [],
  revision?: number | null,
): string {
  const data = ["p", kind, action, ...args.map(String)].join(":");
  return versionedCallback(data, revision);
}

/** Reads a callback from the shared publication namespace. */
export function parsePublicationCallback(data: string): PublicationCallback | null {
  const match = data.match(PUBLICATION_CALLBACK);
  if (!match) return null;
  const [, kind, action, args] = match;
  return {
    kind: kind as PublicationKind,
    action: action ?? "",
    args: args ? args.split(":") : [],
  };
}

/** Parses a positive publication identifier used by publication callbacks. */
export function parseDraftId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Appends a monotonically increasing dialog revision to a callback payload. */
export function versionedCallback(data: string, revision: number | null | undefined): string {
  return revision == null ? data : `sv${revision}|${data}`;
}

/** Separates the optional revision suffix without interpreting the callback namespace. */
export function parseSessionCallback(data: string): SessionCallback {
  const prefix = data.match(SESSION_VERSION_PREFIX);
  const payload = prefix?.[2] ?? data;
  const revision = prefix ? Number(prefix[1]) : null;
  return {
    data: payload,
    callback: parsePublicationCallback(payload),
    revision,
  };
}

/** Rejects a callback or write based on an older dialog generation. */
export function requireSessionRevision(current: number | undefined, expected: number | null, errorCode = "action.session-stale"): void {
  if (expected != null && current !== expected) throw new StudioError(errorCode);
}
