import type { Menu } from "@grammyjs/menu";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { withActionLock } from "../foundation/action-lock.js";
import type { BackendConfig } from "../foundation/config.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { createStudioServices } from "../studio/services/index.js";
import { isStaleCardCallback, PUBLICATION_CARD_FRESHNESS } from "./card-freshness.js";
import { getActiveConversationState, getConversationState } from "./conversation-state.js";
import { executePublicationEffects, type PublicationMessageResult } from "./effects.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { postActionHandlers } from "./post-actions.js";
import { handlePostMessage } from "./post-screen.js";
import type {
  CallbackRouterContext,
  PublicationActionContext,
  PublicationActionHandler,
  PublicationActionResult,
} from "./publication-action-types.js";
import {
  type PublicationCallback,
  type PublicationKind,
  parseDraftId,
  parseSessionCallback,
  requireSessionRevision,
} from "./session-fsm.js";
import { isVideoSessionBoundAction, videoActionHandlers } from "./video-actions.js";
import { handleVideoConversationMessage } from "./video-conversation.js";

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

type CallbackRouterOptions<TArgs, TEntity = undefined, TResult = void> = CallbackRouterBase<TArgs, TEntity, TResult>;

/** Builds a callback-only adapter with common transport, session, and guard handling. */
function createCallbackRouter<TArgs, TEntity = undefined, TResult = void>(
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
      mainMenu,
    };
    const route = options.routes[callback.kind][action];

    try {
      if (!route) {
        await answerCallback(ctx, backendDb, options.unknownText?.(common.locale));
        const keyboard = options.unknownKeyboard?.(common.locale);
        if (keyboard && typeof ctx.reply === "function")
          await ctx.reply(options.unknownText?.(common.locale) ?? "", { reply_markup: keyboard });
        return true;
      }
      if (options.sessionBound?.(common) && revision == null) {
        await answerCallback(ctx, backendDb, options.staleText?.(common.locale));
        return true;
      }
      if (revision != null && options.currentSessionRevision) {
        requireSessionRevision(options.currentSessionRevision(common), revision);
      }

      const entity = options.parseEntity?.(callback, action);
      if (options.parseEntity && entity == null) {
        await answerCallback(ctx, backendDb, options.invalidEntityText?.(common.locale));
        return true;
      }
      if (options.isStale && (await options.isStale(common, entity ?? undefined))) {
        await answerCallback(ctx, backendDb, options.staleText?.(common.locale));
        return true;
      }
      await options.prepare?.(common, entity ?? undefined);
      const locked = await withActionLock(`${actorId}:${data}`, () => route(options.buildArgs(common, entity ?? undefined, mainMenu)));
      await options.onResult?.(common, locked.ok ? locked.value : ([{ type: "answer-callback" }] as TResult));
    } catch (error) {
      if (!options.onError) throw error;
      await options.onError(common, error);
    }
    return true;
  };
}

async function answerCallback(ctx: Context, backendDb: BackendDb, text: string | undefined): Promise<void> {
  await executePublicationEffects(ctx, backendDb, [{ type: "answer-callback", ...(text ? { text } : {}) }]);
}

type PublicationMessageHandler = (ctx: Context, backendDb: BackendDb, config: BackendConfig) => Promise<PublicationMessageResult>;
type PublicationRoutes = {
  post: Record<"cancel_dialog" | keyof typeof postActionHandlers, PublicationActionHandler>;
  video: typeof videoActionHandlers;
};

const MAX_TOAST_LENGTH = 200;

function toast(text: string): string {
  return text.length > MAX_TOAST_LENGTH ? `${text.slice(0, MAX_TOAST_LENGTH - 1)}…` : text;
}

const POST_SESSION_BOUND = new Set(["cancel_state", "sched_confirm", "sched_manual_confirm"]);
const PUBLICATION_MESSAGE_HANDLERS: Record<PublicationKind, PublicationMessageHandler> = {
  post: handlePostMessage,
  video: handleVideoConversationMessage,
};

/** One action table for both publication kinds. Modules only declare handlers. */
const routes: PublicationRoutes = {
  post: {
    cancel_dialog: async ({ backendDb, actorId, revision, mainMenu }) => {
      requireSessionRevision(getConversationState(backendDb, actorId, "post")?.revision, revision);
      return [
        { type: "answer-callback" },
        { type: "session", operation: "clear", kind: "post", actorId },
        ...(mainMenu ? [{ type: "main-menu", menu: mainMenu, edit: true } as const] : []),
      ];
    },
    ...postActionHandlers,
  },
  video: videoActionHandlers,
};

const publicationRouter = createCallbackRouter<PublicationActionContext, number, PublicationActionResult>({
  routes,
  sessionBound: ({ callback, action }) => (callback.kind === "post" ? POST_SESSION_BOUND.has(action) : isVideoSessionBoundAction(action)),
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
    pipeline:
      common.callback.kind === "post"
        ? createStudioServices(common.backendDb, common.config).posts
        : createStudioServices(common.backendDb, common.config).videos,
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
  onResult: async ({ ctx, backendDb, callback }, result) => {
    const effects = result ? [...result] : [];
    if (callback.kind === "video" && !effects.some((effect) => effect.type === "answer-callback" || effect.type === "toast"))
      effects.push({ type: "answer-callback" });
    if (effects.length) await executePublicationEffects(ctx, backendDb, effects);
  },
  onError: async ({ ctx, backendDb, callback, locale }, error) => {
    if (callback.kind === "video")
      return void (await executePublicationEffects(ctx, backendDb, [{ type: "toast", text: toast(describeError(locale, error)) }]));
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

/** Routes a message through the active publication flow, or starts a post when no flow is open. */
export async function handlePublicationMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const actorId = Number(ctx.from?.id);
  const active = getActiveConversationState(backendDb, actorId);
  const result = await routePublicationMessage(ctx, backendDb, config, active?.kind ?? "post");
  if (result.effects.length) await executePublicationEffects(ctx, backendDb, result.effects);
  return result.handled;
}

async function routePublicationMessage(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  kind: PublicationKind,
): Promise<PublicationMessageResult> {
  return PUBLICATION_MESSAGE_HANDLERS[kind](ctx, backendDb, config);
}
