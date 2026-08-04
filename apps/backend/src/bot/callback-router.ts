import type { Menu } from "@grammyjs/menu";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { type BotLocale, botLocale } from "./i18n.js";
import {
  PUBLICATION_ACTIONS,
  type PublicationCallback,
  type PublicationKind,
  parsePublicationCallback,
  parseSessionCallback,
  requireSessionRevision,
} from "./session-fsm.js";

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

type CallbackRouteHandler<TArgs, TResult> = (args: TArgs) => Promise<TResult>;

type CallbackRouterBase<TArgs, TEntity, TResult> = {
  routes: Readonly<Record<string, CallbackRouteHandler<TArgs, TResult>>>;
  sessionBound?: ReadonlySet<string>;
  currentSessionRevision?: (context: CallbackRouterContext) => number | undefined;
  parseEntity?: (callback: PublicationCallback, action: string) => TEntity | null;
  buildArgs: (context: CallbackRouterContext, entity: TEntity | undefined) => TArgs;
  prepare?: (context: CallbackRouterContext, entity: TEntity | undefined) => void | Promise<void>;
  isStale?: (context: CallbackRouterContext, entity: TEntity | undefined) => boolean | Promise<boolean>;
  invalidEntityText?: (locale: BotLocale) => string;
  staleText?: (locale: BotLocale) => string;
  unknownText?: (locale: BotLocale) => string;
  unknownKeyboard?: (locale: BotLocale) => InlineKeyboard;
  onResult?: (context: CallbackRouterContext, result: TResult) => void | Promise<void>;
  onError?: (context: CallbackRouterContext, error: unknown) => void | Promise<void>;
};

export type CallbackRouterOptions<TArgs, TEntity = undefined, TResult = void> = CallbackRouterBase<TArgs, TEntity, TResult> &
  ({ prefix: string; matches?: never } | { matches: (callback: PublicationCallback) => boolean; prefix?: never });

/** Builds a callback-only adapter with common transport, session, and guard handling. */
export function createCallbackRouter<TArgs, TEntity = undefined, TResult = void>(
  options: CallbackRouterOptions<TArgs, TEntity, TResult>,
): (ctx: Context, backendDb: BackendDb, config: BackendConfig) => Promise<boolean> {
  return async (ctx, backendDb, config): Promise<boolean> => {
    const rawData = ctx.callbackQuery?.data;
    if (!rawData) return false;

    const { data, revision } = parseSessionCallback(rawData);
    const callback = parsePublicationCallback(data);
    if (!callback) return false;
    const matches = options.matches ? options.matches(callback) : `${callback.kind}_${callback.action}`.startsWith(options.prefix ?? "");
    if (!matches) return false;

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
    const route = options.routes[action];

    try {
      if (!route) {
        await answerCallback(ctx, options.unknownText?.(common.locale));
        const keyboard = options.unknownKeyboard?.(common.locale);
        if (keyboard) await ctx.reply(options.unknownText?.(common.locale) ?? "", { reply_markup: keyboard });
        return true;
      }
      if (options.sessionBound?.has(action) && revision == null) {
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
      const result = await route(options.buildArgs(common, entity ?? undefined));
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

type PublicationHandler = (
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  mainMenu?: Menu<Context>,
) => Promise<boolean | undefined>;
type PublicationRoutes = {
  [K in PublicationKind]: Record<(typeof PUBLICATION_ACTIONS)[K][number], PublicationHandler>;
};

/** One dispatch table for both publication kinds. Action modules keep the
 * handler declarations; this table owns the publication boundary. */
export const routes: PublicationRoutes = {
  post: Object.fromEntries(
    PUBLICATION_ACTIONS.post.map((action) => [
      action,
      async (ctx, backendDb, config, mainMenu) => {
        if (action === "cancel_dialog") {
          const { handlePostScreenCallback } = await import("./post-screen.js");
          if (!mainMenu) return false;
          return handlePostScreenCallback(ctx, backendDb, mainMenu);
        }
        const { handlePostAction } = await import("./post-actions.js");
        await handlePostAction(ctx, backendDb, config);
      },
    ]),
  ) as PublicationRoutes["post"],
  video: Object.fromEntries(
    PUBLICATION_ACTIONS.video.map((action) => [
      action,
      async (ctx, backendDb, config, mainMenu) => {
        const { handleVideoActionCallback } = await import("./video-actions.js");
        return handleVideoActionCallback(ctx, backendDb, config, mainMenu);
      },
    ]),
  ) as PublicationRoutes["video"],
};

/** Dispatches canonical publication callbacks through the shared action map. */
export async function handlePublicationCallback(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  mainMenu?: Menu<Context>,
): Promise<boolean> {
  const rawData = ctx.callbackQuery?.data;
  if (!rawData) return false;
  const { data } = parseSessionCallback(rawData);
  const callback = parsePublicationCallback(data);
  if (!callback) return false;
  const handler = routes[callback.kind][callback.action as keyof (typeof routes)[typeof callback.kind]];
  if (!handler) {
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    await answerCallback(ctx, t(locale, "action.card-stale"));
    await ctx.reply(t(locale, "action.card-stale"), {
      reply_markup: new InlineKeyboard().text(t(locale, "menu.work-queue"), "queue_home"),
    });
    return true;
  }
  return (await handler(ctx, backendDb, config, mainMenu)) !== false;
}

/** Routes incoming text/media to the one active publication conversation. */
export async function handleActivePublicationMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const actorId = Number(ctx.from?.id);
  const { getConversationState } = await import("./conversation-state.js");
  if (getConversationState(backendDb, actorId, "video")) {
    const { handleVideoConversationMessage } = await import("./video-conversation.js");
    return handleVideoConversationMessage(ctx, backendDb, config);
  }
  if (getConversationState(backendDb, actorId, "post")) {
    const { handlePostMessage } = await import("./post-screen.js");
    await handlePostMessage(ctx, backendDb, config);
    return true;
  }
  return false;
}
