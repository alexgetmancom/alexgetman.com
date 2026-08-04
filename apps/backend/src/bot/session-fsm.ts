import type { PublicationKind } from "../application/conversation-flow.js";
import { StudioError } from "../foundation/errors.js";

export type { PublicationKind } from "../application/conversation-flow.js";

const SESSION_VERSION_PREFIX = /^sv(\d+)\|(.*)$/;
const LEGACY_SESSION_VERSION_SUFFIX = /^(.*):sv(\d+)$/;
const PUBLICATION_CALLBACK = /^p:(post|video):([^:]+)(?::(.*))?$/;
const LEGACY_VIDEO_PREFIX = "video_";

export type SessionCallback = { data: string; revision: number | null };
export type PublicationCallback = {
  kind: PublicationKind;
  action: string;
  args: string[];
};

/** The canonical callback vocabulary for every publication workflow. */
export const PUBLICATION_ACTIONS = {
  post: [
    "toggle",
    "preview",
    "platforms",
    "cycle_mode",
    "cancel_state",
    "edit_ru",
    "edit_en",
    "replace_ru_media",
    "replace_en_media",
    "sources",
    "cancel",
    "cancel_confirm",
    "post_retry",
    "post_retry_notice",
    "publish",
    "story_publish_all",
    "story_publish_site",
    "story_schedule_all",
    "story_schedule_site",
    "threads_chain",
    "publish_confirm",
    "schedule",
    "sched_scope",
    "sched_view",
    "sched_pick",
    "sched_manual_confirm",
    "sched_manual",
  ],
  video: [
    "start",
    "locale",
    "cancel_dialog",
    "toggle",
    "targets_done",
    "game_skip",
    "meta_back",
    "open",
    "retry",
    "cancel_notice",
    "schedule_confirm",
    "schedule",
    "common",
    "individual",
    "now",
    "now_confirm",
    "cancel_ask",
    "remove_ask",
    "cancel",
    "time",
    "sched_pick",
    "sched_manual",
    "remove",
    "edit_menu",
    "edit_field",
    "edit",
  ],
} as const satisfies Record<PublicationKind, readonly string[]>;

type PublicationAction = (typeof PUBLICATION_ACTIONS)[PublicationKind][number];

/** Builds the compact callback namespace shared by post and video controls. */
export function publicationCallback(
  kind: PublicationKind,
  action: PublicationAction | string,
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
    args: normalizePublicationArgs(kind as PublicationKind, action ?? "", args ? args.split(":") : []),
  };
}

/**
 * Translates callbacks emitted before the shared namespace was enforced.
 * This is the only compatibility table for bare post names and video-prefixed
 * names. It also keeps callbacks already sitting in Telegram usable while the
 * canonical argument order is rolled out.
 */
export function legacyToPublication(data: string): PublicationCallback | null {
  const separator = data.indexOf(":");
  const key = separator === -1 ? data : data.slice(0, separator);
  const rawArgs = separator === -1 ? [] : data.slice(separator + 1).split(":");

  if (key.startsWith(LEGACY_VIDEO_PREFIX)) {
    const action = key.slice(LEGACY_VIDEO_PREFIX.length);
    if (!action) return null;
    return { kind: "video", action, args: normalizePublicationArgs("video", action, rawArgs) };
  }
  if (!PUBLICATION_ACTIONS.post.includes(key as (typeof PUBLICATION_ACTIONS.post)[number])) return null;
  return { kind: "post", action: key, args: normalizePublicationArgs("post", key, rawArgs) };
}

/** Resolves either a canonical callback or a legacy callback payload. */
export function publicationFromCallbackData(data: string): PublicationCallback | null {
  return parsePublicationCallback(data) ?? legacyToPublication(data);
}

/** Parses a positive draft identifier used by publication callbacks. */
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
  if (prefix) return { data: prefix[2] ?? "", revision: Number(prefix[1]) };
  // Keep accepting callbacks emitted before the unambiguous prefix format was
  // deployed. New payloads never inspect an arbitrary final `:svN` segment.
  const legacy = data.match(LEGACY_SESSION_VERSION_SUFFIX);
  if (!legacy) return { data, revision: null };
  return { data: legacy[1] ?? "", revision: Number(legacy[2]) };
}

function normalizePublicationArgs(kind: PublicationKind, action: string, args: string[]): string[] {
  const legacyNumericClock = kind === "video" && action === "sched_pick" && /^\d{4}$/.test(args[0] ?? "") && parseDraftId(args[1]) != null;
  if (args.length < 2 || (!legacyNumericClock && parseDraftId(args[0]) != null) || parseDraftId(args.at(-1)) == null) return args;
  // Before the namespace became canonical, video actions placed their target
  // or field before the draft id, and post scheduling did the same with scope,
  // view, or clock. The new contract always puts draftId at args[0].
  return [args.at(-1) as string, ...args.slice(0, -1)];
}

/** Rejects a callback or write based on an older dialog generation. */
export function requireSessionRevision(current: number | undefined, expected: number | null, errorCode = "action.session-stale"): void {
  if (expected != null && current !== expected) throw new StudioError(errorCode);
}

/** Shared transition guard for every conversational FSM. */
export function requireSessionStep(current: string | undefined, allowed: readonly string[], errorCode: string): void {
  if (!current || !allowed.includes(current)) throw new StudioError(errorCode);
}
