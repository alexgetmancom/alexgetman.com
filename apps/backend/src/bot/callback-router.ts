import type { Menu } from "@grammyjs/menu";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { createStudioServices } from "../studio/services/index.js";
import { isStaleCardCallback, PUBLICATION_CARD_FRESHNESS } from "./card-freshness.js";
import { getConversationState } from "./conversation-state.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { postActionHandlers } from "./post-actions.js";
import { handlePostMessage, handlePostScreenCallback } from "./post-screen.js";
import {
  type PUBLICATION_ACTIONS,
  type PublicationCallback,
  type PublicationKind,
  parseDraftId,
  parseSessionCallback,
  requireSessionRevision,
} from "./session-fsm.js";
import { videoActionHandlers } from "./video-actions.js";
import { handleVideoConversationMessage } from "./video-conversation.js";

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
};

export type PublicationActionContext = CallbackRouterContext & {
  first: string | undefined;
  second: string | undefined;
  draftId: number;
  mainMenu: Menu<Context> | undefined;
  posts: ReturnType<typeof createStudioServices>["posts"];
};

type CallbackRouteHandler<TArgs, TResult> = (args: TArgs) => Promise<TResult>;

type CallbackRouterBase<TArgs, TEntity, TResult> = {
  routes: Readonly<Record<PublicationKind, Readonly<Record<string, CallbackRouteHandler<TArgs, TResult>>>>>;
  sessionBound?: (context: CallbackRouterContext) => boolean;
  currentSessionRevision?: (context: CallbackRouterContext) => number | undefined;
  parseEntity?: (callback: PublicationCallback, action: string) => TEntity | null;
  buildArgs: (context: CallbackRouterContext, entity: TEntity | undefined, mainMenu?: Menu<Context>) => TArgs;
  prepare?: (context: CallbackRouterContext, entity: TEntity | undefined) => void | Promise<void>;
  isStale?: (context: CallbackRouterContext, entity: TEntity | undefined) => boolean | Promise<boolean>;
  invalidEntityText?: (locale: BotLocale) => string;
  staleText?: (locale: BotLocale) => string;
  unknownText?: (locale: BotLocale) => string;
  unknownKeyboard?: (locale: BotLocale) => InlineKeyboard;
  onResult?: (context: CallbackRouterContext, result: TResult) => void | Promise<void>;
  onError?: (context: CallbackRouterContext, error: unknown) => void | Promise<void>;
};

export type CallbackRouterOptions<TArgs, TEntity = undefined, TResult = void> = CallbackRouterBase<TArgs, TEntity, TResult>;

/** Builds a callback-only adapter with common transport, session, and guard handling. */
export function createCallbackRouter<TArgs, TEntity = undefined, TResult = void>(
  options: CallbackRouterOptions<TArgs, TEntity, TResult>,
): (ctx: Context, backendDb: BackendDb, config: BackendConfig, mainMenu?: Menu<Context>) => Promise<boolean> {
  return async (ctx, backendDb, config, mainMenu): Promise<boolean> => {
    const rawData = ctx.callbackQuery?.data;
    if (!rawData) return false;

    const { data, callback, revision } = parseSessionCallback(rawData);
    if (!callback) return false;
    const parts = [callback.action, ...callback.args];
    const action = callback.action;
    const actorId = Number(ctx.from?.id);
    const common: CallbackRouterContext = {
      ctx,
      backendDb,
      config,
      actorId,
      locale: botLocale(backendDb, actorId),
      data,
      callback,
      action,
      revision,
      parts,
      args: callback.args,
    };
    const route = options.routes[callback.kind][action];

    try {
      if (!route) {
        await answerCallback(ctx, options.unknownText?.(common.locale));
        const keyboard = options.unknownKeyboard?.(common.locale);
        if (keyboard && typeof ctx.reply === "function")
          await ctx.reply(options.unknownText?.(common.locale) ?? "", { reply_markup: keyboard });
        return true;
      }
      if (options.sessionBound?.(common) && revision == null) {
        await answerCallback(ctx, options.staleText?.(common.locale));
        return true;
      }
      if (revision != null && options.currentSessionRevision) {
        requireSessionRevision(options.currentSessionRevision(common), revision);
      }

      const entity = options.parseEntity?.(callback, action);
      if (options.parseEntity && entity == null) {
        await answerCallback(ctx, options.invalidEntityText?.(common.locale));
        return true;
      }
      if (options.isStale && (await options.isStale(common, entity ?? undefined))) {
        await answerCallback(ctx, options.staleText?.(common.locale));
        return true;
      }
      await options.prepare?.(common, entity ?? undefined);
      const result = await route(options.buildArgs(common, entity ?? undefined, mainMenu));
      await options.onResult?.(common, result);
    } catch (error) {
      if (!options.onError) throw error;
      await options.onError(common, error);
    }
    return true;
  };
}

async function answerCallback(ctx: Context, text: string | undefined): Promise<void> {
  await ctx.answerCallbackQuery(text ? { text } : undefined);
}

type PublicationHandler = (args: PublicationActionContext) => Promise<PublicationActionResult>;
// biome-ignore lint/suspicious/noConfusingVoidType: action declarations intentionally return no toast on the normal path.
type PublicationActionResult = { toast?: string } | void;
type PublicationRoutes = {
  [K in PublicationKind]: Record<(typeof PUBLICATION_ACTIONS)[K][number], PublicationHandler>;
};

const MAX_TOAST_LENGTH = 200;

function toast(text: string): string {
  return text.length > MAX_TOAST_LENGTH ? `${text.slice(0, MAX_TOAST_LENGTH - 1)}…` : text;
}

const POST_SESSION_BOUND = new Set(["cancel_state", "sched_manual_confirm"]);
const VIDEO_SESSION_BOUND = new Set([
  "locale",
  "cancel_dialog",
  "toggle",
  "targets_done",
  "game_skip",
  "meta_back",
  "schedule_confirm",
  "now_confirm",
  "common",
  "individual",
  "sched_pick",
  "sched_manual",
]);

/** One action table for both publication kinds. Modules only declare handlers. */
export const routes: PublicationRoutes = {
  post: {
    cancel_dialog: async ({ ctx, backendDb, mainMenu }) => {
      if (!mainMenu) return;
      await handlePostScreenCallback(ctx, backendDb, mainMenu);
    },
    ...postActionHandlers,
  },
  video: videoActionHandlers,
};

const publicationRouter = createCallbackRouter<PublicationActionContext, number, PublicationActionResult>({
  routes,
  sessionBound: ({ callback, action }) => (callback.kind === "post" ? POST_SESSION_BOUND : VIDEO_SESSION_BOUND).has(action),
  currentSessionRevision: ({ backendDb, actorId, callback }) => getConversationState(backendDb, actorId, callback.kind)?.revision,
  parseEntity: (callback) => {
    if (callback.kind !== "post" || callback.action === "cancel_dialog") return 0;
    return parseDraftId(callback.args[0]);
  },
  buildArgs: (common, draftId, mainMenu) => ({
    ...common,
    first: common.args[1],
    second: common.args[2],
    draftId: draftId ?? 0,
    mainMenu,
    posts: createStudioServices(common.backendDb, common.config).posts,
  }),
  prepare: ({ backendDb, config, actorId, callback }, draftId) => {
    if (callback.kind === "post" && callback.action !== "cancel_dialog")
      createStudioServices(backendDb, config).posts.get(actorId, draftId as number);
  },
  isStale: ({ ctx, backendDb, callback }) => isStaleCardCallback(ctx, backendDb, callback, PUBLICATION_CARD_FRESHNESS),
  invalidEntityText: (locale) => t(locale, "action.invalid-post"),
  staleText: (locale) => t(locale, "action.card-stale"),
  unknownText: (locale) => t(locale, "action.card-stale"),
  unknownKeyboard: (locale) => new InlineKeyboard().text(t(locale, "menu.work-queue"), "queue_home"),
  onResult: async ({ ctx, callback }, result) => {
    if (callback.kind === "video") await ctx.answerCallbackQuery(result?.toast ? { text: toast(result.toast) } : undefined);
  },
  onError: async ({ ctx, callback, locale }, error) => {
    if (callback.kind === "video") return void (await ctx.answerCallbackQuery({ text: toast(describeError(locale, error)) }));
    throw error;
  },
});

/** Dispatches canonical publication callbacks through the shared action map. */
export async function handlePublicationCallback(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  mainMenu?: Menu<Context>,
): Promise<boolean> {
  return publicationRouter(ctx, backendDb, config, mainMenu);
}

/** Routes incoming text/media to the one active publication conversation. */
export async function handleActivePublicationMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const actorId = Number(ctx.from?.id);
  if (getConversationState(backendDb, actorId, "video")) {
    return handleVideoConversationMessage(ctx, backendDb, config);
  }
  if (getConversationState(backendDb, actorId, "post")) {
    await handlePostMessage(ctx, backendDb, config);
    return true;
  }
  return false;
}
