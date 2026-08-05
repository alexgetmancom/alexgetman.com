import type { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { PublicationPipeline } from "../application/publication-pipeline.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { StudioServices } from "../studio/services/index.js";
import type { PublicationEffect } from "./effects.js";
import type { BotLocale } from "./i18n.js";
import { POST_ACTION_KEYS, POST_CARD_ACTIONS, type PostActionKey, type PublicationCallback, type PublicationKind } from "./session-fsm.js";

export type ActionMetadata = {
  entity: "draft" | "session" | "none";
  requiresFreshCard?: boolean;
  requiresSessionRevision?: boolean;
};

/** Video callbacks whose first argument is always the video draft id. */
export const VIDEO_DRAFT_ACTIONS = [
  "open",
  "retry",
  "cancel_notice",
  "schedule_confirm",
  "sched_confirm",
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
] as const;

export type VideoDraftAction = (typeof VIDEO_DRAFT_ACTIONS)[number];

/** Video callbacks that must originate from the current video card. */
export const VIDEO_CARD_ACTIONS = [
  "schedule_confirm",
  "sched_confirm",
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
] as const satisfies readonly VideoDraftAction[];

type VideoCardAction = (typeof VIDEO_CARD_ACTIONS)[number];

/** Video wizard callbacks use the active session and intentionally have no id. */
export const VIDEO_SESSION_ACTIONS = ["locale", "cancel_dialog", "toggle", "targets_done", "game_skip", "meta_back"] as const;

type VideoSessionAction = (typeof VIDEO_SESSION_ACTIONS)[number];
type VideoActionKey = VideoDraftAction | VideoSessionAction | "start";

const VIDEO_ACTION_KEYS = [...VIDEO_DRAFT_ACTIONS, ...VIDEO_SESSION_ACTIONS, "start"] as const satisfies readonly VideoActionKey[];

const draftMetadata = (requiresFreshCard = false): ActionMetadata => ({
  entity: "draft",
  ...(requiresFreshCard ? { requiresFreshCard: true } : {}),
});

function buildMetadataTable<const Keys extends readonly string[]>(
  keys: Keys,
  create: (action: Keys[number]) => ActionMetadata,
): { [Key in Keys[number]]: ActionMetadata } {
  return Object.fromEntries(keys.map((action) => [action, create(action)])) as {
    [Key in Keys[number]]: ActionMetadata;
  };
}

const postMetadata = buildMetadataTable(POST_ACTION_KEYS, (action) =>
  action === "cancel_dialog"
    ? { entity: "session", requiresSessionRevision: true }
    : draftMetadata((POST_CARD_ACTIONS.post as readonly string[]).includes(action)),
);

const videoMetadata = buildMetadataTable(VIDEO_ACTION_KEYS, (action) => {
  if (action === "start") return { entity: "none" };
  if (VIDEO_SESSION_ACTIONS.includes(action as VideoSessionAction)) return { entity: "session", requiresSessionRevision: true };
  return draftMetadata(VIDEO_CARD_ACTIONS.includes(action as VideoCardAction));
});

/** Mechanical callback properties shared by the publication router and card freshness checks. */
export const ACTION_METADATA = {
  post: postMetadata,
  video: videoMetadata,
} satisfies {
  post: Readonly<Record<PostActionKey, ActionMetadata>>;
  video: Readonly<Record<VideoActionKey, ActionMetadata>>;
};

export function actionMetadata(kind: PublicationKind, action: string): ActionMetadata | undefined {
  if (kind === "post") {
    if (!POST_ACTION_KEYS.includes(action as PostActionKey)) return undefined;
    return ACTION_METADATA.post[action as PostActionKey];
  }
  if (!VIDEO_ACTION_KEYS.includes(action as VideoActionKey)) return undefined;
  return ACTION_METADATA.video[action as VideoActionKey];
}

export type CallbackRouterContext = {
  ctx: Context;
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  locale: BotLocale;
  data: string;
  callback: PublicationCallback;
  action: string;
  revision: number | null;
  parts: string[];
  args: string[];
  mainMenu?: Menu<Context> | undefined;
};

export type PublicationActionContext = CallbackRouterContext & {
  first: string | undefined;
  second: string | undefined;
  draftId: number;
  mainMenu: Menu<Context> | undefined;
  pipeline: PublicationPipeline;
  services: StudioServices;
};

// biome-ignore lint/suspicious/noConfusingVoidType: action declarations intentionally return no effect on the normal path.
export type PublicationActionResult = readonly PublicationEffect[] | void;

export type PublicationActionHandler = (args: PublicationActionContext) => Promise<PublicationActionResult>;
