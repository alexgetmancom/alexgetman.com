import { StudioError } from "../foundation/errors.js";

const SESSION_VERSION_PREFIX = /^sv(\d+)\|(.*)$/;
const LEGACY_SESSION_VERSION_SUFFIX = /^(.*):sv(\d+)$/;
const PUBLICATION_CALLBACK = /^p:(post|video):([^:]+)(?::(.*))?$/;

export type SessionCallback = { data: string; revision: number | null };
export type PublicationKind = "post" | "video";
export type PublicationCallback = {
  kind: PublicationKind;
  action: string;
  args: string[];
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

export function callbackAction(data: string): string {
  const publication = parsePublicationCallback(data);
  if (publication) return publication.kind === "video" ? `video_${publication.action}` : publication.action;
  const separator = data.indexOf(":");
  return separator === -1 ? data : data.slice(0, separator);
}

/** Appends a monotonically increasing dialog revision to a callback payload. */
export function versionedCallback(data: string, revision: number | null | undefined): string {
  return revision == null ? data : `sv${revision}|${data}`;
}

/** Separates the optional revision suffix without making individual handlers
 * know how Telegram transport metadata is encoded. */
export function parseSessionCallback(data: string): SessionCallback {
  const prefix = data.match(SESSION_VERSION_PREFIX);
  if (prefix) return { data: normalizePublicationCallback(prefix[2] ?? ""), revision: Number(prefix[1]) };
  // Keep accepting callbacks emitted before the unambiguous prefix format was
  // deployed. New payloads never inspect an arbitrary final `:svN` segment.
  const legacy = data.match(LEGACY_SESSION_VERSION_SUFFIX);
  if (!legacy) return { data: normalizePublicationCallback(data), revision: null };
  return { data: normalizePublicationCallback(legacy[1] ?? ""), revision: Number(legacy[2]) };
}

function normalizePublicationCallback(data: string): string {
  const publication = parsePublicationCallback(data);
  if (!publication) return data;
  const legacyAction = publication.kind === "video" ? `video_${publication.action}` : publication.action;
  return [legacyAction, ...publication.args].join(":");
}

/** Rejects a callback or write based on an older dialog generation. */
export function requireSessionRevision(current: number | undefined, expected: number | null, errorCode = "action.session-stale"): void {
  if (expected != null && current !== expected) throw new StudioError(errorCode);
}

/** Shared transition guard for every conversational FSM. */
export function requireSessionStep(current: string | undefined, allowed: readonly string[], errorCode: string): void {
  if (!current || !allowed.includes(current)) throw new StudioError(errorCode);
}
