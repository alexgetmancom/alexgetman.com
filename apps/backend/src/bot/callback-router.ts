import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { callbackAction, parseSessionCallback, requireSessionRevision } from "./session-fsm.js";

export type CallbackRouterContext = {
  ctx: Context;
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  locale: BotLocale;
  data: string;
  action: string;
  revision: number | null;
  parts: string[];
};

export type CallbackRouteHandler<TArgs, TResult> = (args: TArgs) => Promise<TResult>;

export type CallbackRouterOptions<TArgs, TEntity = undefined, TResult = void> = {
  prefix: string;
  matches?: (data: string) => boolean;
  routes: Readonly<Record<string, CallbackRouteHandler<TArgs, TResult>>>;
  sessionBound?: ReadonlySet<string>;
  currentSessionRevision?: (context: CallbackRouterContext) => number | undefined;
  parseEntity?: (data: string, action: string) => TEntity | null;
  buildArgs: (context: CallbackRouterContext, entity: TEntity | undefined) => TArgs;
  prepare?: (context: CallbackRouterContext, entity: TEntity | undefined) => void | Promise<void>;
  isStale?: (context: CallbackRouterContext, entity: TEntity | undefined) => boolean | Promise<boolean>;
  invalidEntityText?: (locale: BotLocale) => string;
  staleText?: (locale: BotLocale) => string;
  unknownText?: (locale: BotLocale) => string;
  onResult?: (context: CallbackRouterContext, result: TResult) => void | Promise<void>;
  onError?: (context: CallbackRouterContext, error: unknown) => void | Promise<void>;
};

/** Builds a callback-only adapter with common transport, session, and guard handling. */
export function createCallbackRouter<TArgs, TEntity = undefined, TResult = void>(
  options: CallbackRouterOptions<TArgs, TEntity, TResult>,
): (ctx: Context, backendDb: BackendDb, config: BackendConfig) => Promise<boolean> {
  return async (ctx, backendDb, config): Promise<boolean> => {
    const rawData = ctx.callbackQuery?.data;
    if (!rawData) return false;

    const { data, revision } = parseSessionCallback(rawData);
    if (options.matches ? !options.matches(data) : !data.startsWith(options.prefix)) return false;

    const parts = data.split(":");
    const action = callbackAction(data);
    const actorId = Number(ctx.from?.id);
    const common: CallbackRouterContext = {
      ctx,
      backendDb,
      config,
      actorId,
      locale: botLocale(backendDb, actorId),
      data,
      action,
      revision,
      parts,
    };
    const route = options.routes[action];

    try {
      if (!route) {
        await answerCallback(ctx, options.unknownText?.(common.locale));
        return true;
      }
      if (options.sessionBound?.has(action) && revision == null) {
        await answerCallback(ctx, options.staleText?.(common.locale));
        return true;
      }
      if (revision != null && options.currentSessionRevision) {
        requireSessionRevision(options.currentSessionRevision(common), revision);
      }

      const entity = options.parseEntity?.(data, action);
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
