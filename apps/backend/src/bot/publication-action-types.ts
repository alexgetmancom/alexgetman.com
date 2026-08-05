import type { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { PublicationPipeline } from "../application/publication-pipeline.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { StudioServices } from "../studio/services/index.js";
import type { PublicationEffect } from "./effects.js";
import type { BotLocale } from "./i18n.js";
import { POST_ACTION_KEYS, POST_CARD_ACTIONS, type PublicationCallback, type PublicationKind } from "./session-fsm.js";

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

/** Video wizard callbacks use the active session and intentionally have no id. */
export const VIDEO_SESSION_ACTIONS = ["locale", "cancel_dialog", "toggle", "targets_done", "game_skip", "meta_back"] as const;

export type VideoSessionAction = (typeof VIDEO_SESSION_ACTIONS)[number];

const draftMetadata = (requiresFreshCard = false): ActionMetadata => ({
  entity: "draft",
  ...(requiresFreshCard ? { requiresFreshCard: true } : {}),
});

const postMetadata = Object.fromEntries(
  POST_ACTION_KEYS.map((action) => [
    action,
    action === "cancel_dialog"
      ? ({ entity: "session", requiresSessionRevision: true } satisfies ActionMetadata)
      : draftMetadata((POST_CARD_ACTIONS.post as readonly string[]).includes(action)),
  ]),
) as Record<string, ActionMetadata>;

const videoMetadata = Object.fromEntries([
  ...VIDEO_DRAFT_ACTIONS.map((action) => [
    action,
    draftMetadata(
      [
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
      ].includes(action),
    ),
  ]),
  ...VIDEO_SESSION_ACTIONS.map((action) => [action, { entity: "session", requiresSessionRevision: true } satisfies ActionMetadata]),
  ["start", { entity: "none" } satisfies ActionMetadata],
]) as Record<string, ActionMetadata>;

/** Mechanical callback properties shared by the publication router and card freshness checks. */
export const ACTION_METADATA: Record<PublicationKind, Readonly<Record<string, ActionMetadata>>> = {
  post: postMetadata,
  video: videoMetadata,
};

export function actionMetadata(kind: PublicationKind, action: string): ActionMetadata {
  return ACTION_METADATA[kind][action] ?? { entity: "none" };
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
