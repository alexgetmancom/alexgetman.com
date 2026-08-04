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

/** The canonical callback vocabulary for every publication workflow. */
export const PUBLICATION_ACTIONS = {
  post: [
    "cancel_dialog",
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

/** Callback actions whose card identity must be checked before execution. */
export const PUBLICATION_CARD_ACTIONS = {
  post: [
    "toggle",
    "cycle_mode",
    "sources",
    "edit_ru",
    "edit_en",
    "replace_ru_media",
    "replace_en_media",
    "cancel",
    "cancel_confirm",
    "post_retry",
    "publish",
    "publish_confirm",
    "schedule",
    "sched_scope",
    "sched_view",
    "sched_pick",
    "sched_manual",
    "story_publish_all",
    "story_publish_site",
    "story_schedule_all",
    "story_schedule_site",
    "threads_chain",
  ],
  video: [
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
export type PostActionKey = (typeof PUBLICATION_ACTIONS.post)[number];
export type VideoActionKey = (typeof PUBLICATION_ACTIONS.video)[number];

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
    args: args ? args.split(":") : [],
  };
}

type LegacyPublicationAction = Pick<PublicationCallback, "kind" | "action">;

/** The only compatibility table for callbacks emitted before `p:` existed. */
const LEGACY_PUBLICATION_ACTIONS: Readonly<Record<string, LegacyPublicationAction>> = Object.fromEntries([
  ...PUBLICATION_ACTIONS.post.map((action) => [action, { kind: "post", action }]),
  ...PUBLICATION_ACTIONS.video.map((action) => [`video_${action}`, { kind: "video", action }]),
]) as Readonly<Record<string, LegacyPublicationAction>>;

const LEGACY_VIDEO_ARGUMENTS: Partial<Record<VideoActionKey, (args: string[]) => string[]>> = {
  retry: moveTargetAndDraftId,
  remove_ask: moveTargetAndDraftId,
  time: moveTargetAndDraftId,
  remove: moveTargetAndDraftId,
  sched_pick: moveSecondAndFirst,
  edit_field: moveSecondAndFirst,
};

const LEGACY_POST_ARGUMENTS: Partial<Record<PostActionKey, (args: string[]) => string[]>> = {
  sched_scope: moveSecondAndFirst,
  sched_view: moveSecondAndFirst,
  sched_manual: moveSecondAndFirst,
  sched_pick: moveLastToFront,
};

/** Translates one pre-namespace callback into the canonical object shape. */
export function legacyToPublication(data: string): PublicationCallback | null {
  const [name, ...args] = data.split(":");
  const legacy = LEGACY_PUBLICATION_ACTIONS[name ?? ""];
  if (!legacy) return null;
  const normalizer =
    legacy.kind === "video"
      ? LEGACY_VIDEO_ARGUMENTS[legacy.action as VideoActionKey]
      : LEGACY_POST_ARGUMENTS[legacy.action as PostActionKey];
  const normalizedArgs = normalizer?.(args) ?? args;
  return { ...legacy, args: normalizedArgs };
}

function moveTargetAndDraftId(args: string[]): string[] {
  if (args.length < 2) return args;
  const [target, draftId, ...rest] = args;
  return [draftId as string, target as string, ...rest];
}

function moveSecondAndFirst(args: string[]): string[] {
  if (args.length < 2) return args;
  const [first, second, ...rest] = args;
  return [second as string, first as string, ...rest];
}

function moveLastToFront(args: string[]): string[] {
  if (args.length < 2) return args;
  const last = args.at(-1);
  return last === undefined ? args : [last, ...args.slice(0, -1)];
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
  const payload = prefix?.[2] ?? data;
  const revision = prefix ? Number(prefix[1]) : null;
  return {
    data: payload,
    callback: parsePublicationCallback(payload) ?? legacyToPublication(payload),
    revision,
  };
}

/** Rejects a callback or write based on an older dialog generation. */
export function requireSessionRevision(current: number | undefined, expected: number | null, errorCode = "action.session-stale"): void {
  if (expected != null && current !== expected) throw new StudioError(errorCode);
}

/** Shared transition guard for every conversational FSM. */
export function requireSessionStep(current: string | undefined, allowed: readonly string[], errorCode: string): void {
  if (!current || !allowed.includes(current)) throw new StudioError(errorCode);
}
