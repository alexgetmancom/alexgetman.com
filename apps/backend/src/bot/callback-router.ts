import type { Menu } from "@grammyjs/menu";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { withActionLock } from "../foundation/action-lock.js";
import type { BackendConfig } from "../foundation/config.js";
import { type MessageKey, t } from "../foundation/i18n/index.js";
import { telegramPostCard, telegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { createStudioServices } from "../studio/services/index.js";
import { getActiveConversationState, getConversationState } from "./conversation-state.js";
import { executePublicationEffects, type PublicationMessageResult } from "./effects.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { handlePostMessage } from "./post-screen.js";
import type { PublicationActionContext, PublicationActionDefinition } from "./publication-action-contract.js";
import { describePublicationError, isFreshPublicationAction, logPublicationActionError, publicationAction } from "./publication-actions.js";
import {
  type PublicationCallback,
  type PublicationKind,
  parseDraftId,
  parseSessionCallback,
  requireSessionRevision,
} from "./publication-callback.js";
import { publicationRenderers } from "./publication-renderers.js";
import { handleVideoConversationMessage } from "./video-conversation.js";

type CallbackRouterContext = Omit<PublicationActionContext, "args" | "draftId" | "pipeline" | "services" | "renderer"> & {
  data: string;
  rawArgs: string[];
};

type PublicationMessageHandler = (ctx: Context, backendDb: BackendDb, config: BackendConfig) => Promise<PublicationMessageResult>;

const PUBLICATION_MESSAGE_HANDLERS: Record<PublicationKind, PublicationMessageHandler> = {
  post: handlePostMessage,
  video: handleVideoConversationMessage,
};

const INVALID_ENTITY_TEXT: Record<PublicationKind, MessageKey> = {
  post: "action.invalid-post",
  video: "err.video-reopen-create",
};

const UNKNOWN_KEYBOARD = (locale: BotLocale): InlineKeyboard => new InlineKeyboard().text(t(locale, "menu.work-queue"), "queue_home");

/** Dispatches a Telegram publication callback through the single action registry. */
export async function handlePublicationCallback(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  mainMenu?: Menu<Context>,
): Promise<boolean> {
  const rawData = ctx.callbackQuery?.data;
  if (!rawData) return false;
  const parsed = parseSessionCallback(rawData);
  const callback = parsed.callback;
  if (!callback) return false;

  const actorId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, actorId);
  const action = publicationAction(callback.kind, callback.action);
  const common = {
    ctx,
    backendDb,
    config,
    actorId,
    locale,
    data: parsed.data,
    callback,
    action: callback.action,
    revision: parsed.revision,
    rawArgs: callback.args,
    mainMenu,
    invalidEntityCode: INVALID_ENTITY_TEXT[callback.kind],
  } satisfies CallbackRouterContext;
  const services = createStudioServices(backendDb, config);

  try {
    if (!action) {
      await staleCallback(ctx, backendDb, locale, true);
      return true;
    }

    const pipeline = { post: services.posts, video: services.videos }[callback.kind];
    const renderer = publicationRenderers(backendDb, config, services)[callback.kind];
    const draftId = action.entity === "draft" ? parseDraftId(callback.args[0]) : undefined;
    if (action.entity === "draft" && draftId == null) {
      await answerCallback(ctx, backendDb, t(locale, INVALID_ENTITY_TEXT[callback.kind]));
      return true;
    }
    if (!hasDeclaredArguments(action, callback.args, action.entity === "draft")) {
      await staleCallback(ctx, backendDb, locale, false);
      return true;
    }

    const session = getConversationState(backendDb, actorId, callback.kind);
    if (action.sessionRevision && parsed.revision == null) {
      await staleCallback(ctx, backendDb, locale, false);
      return true;
    }
    if (parsed.revision != null) requireSessionRevision(session?.revision, parsed.revision);
    if (action.freshCard && isStaleCardCallback(ctx, backendDb, callback)) {
      await staleCallback(ctx, backendDb, locale, false);
      return true;
    }
    if (draftId != null) pipeline.get(actorId, draftId);

    const actionContext: PublicationActionContext = {
      ...common,
      args: namedArguments(action, callback.args, action.entity === "draft"),
      draftId: draftId ?? 0,
      pipeline,
      services,
      renderer,
      invalidEntityCode: common.invalidEntityCode,
    };
    const locked = await withActionLock(`${actorId}:${parsed.data}`, () => action.handler(actionContext));
    const effects = locked.ok ? [...(locked.value ?? [])] : [{ type: "answer-callback" as const }];
    if (!effects.some((effect) => effect.type === "answer-callback" || effect.type === "toast"))
      effects.unshift({ type: "answer-callback" });
    if (effects.length) await executePublicationEffects(ctx, backendDb, effects);
  } catch (error) {
    logPublicationActionError(common, error);
    const timeConfig = services.settings.timeConfig(actorId, config);
    await executePublicationEffects(ctx, backendDb, [{ type: "toast", text: toast(describePublicationError(locale, error, timeConfig)) }]);
  }
  return true;
}

export function isStaleCardCallback(ctx: Context, backendDb: BackendDb, callback: PublicationCallback): boolean {
  if (!isFreshPublicationAction(callback.kind, callback.action)) return false;
  const draftId = parseDraftId(callback.args[0]);
  if (draftId == null) return false;
  const currentMessageId = {
    post: telegramPostCard(backendDb, draftId)?.messageId,
    video: telegramVideoCard(backendDb, draftId)?.messageId,
  }[callback.kind];
  const callbackMessage = ctx.callbackQuery?.message;
  const messageId = callbackMessage && "message_id" in callbackMessage ? callbackMessage.message_id : null;
  return messageId != null && currentMessageId != null && messageId !== currentMessageId;
}

/** Routes a message through the active publication flow, or starts a post when no flow is open. */
export async function handlePublicationMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const actorId = Number(ctx.from?.id);
  const active = getActiveConversationState(backendDb, actorId);
  const result = await PUBLICATION_MESSAGE_HANDLERS[active?.kind ?? "post"](ctx, backendDb, config);
  if (result.effects.length) await executePublicationEffects(ctx, backendDb, result.effects);
  return result.handled;
}

function hasDeclaredArguments(action: PublicationActionDefinition, callbackArgs: string[], hasDraftId: boolean): boolean {
  const values = hasDraftId ? callbackArgs.slice(1) : callbackArgs;
  return values.length === action.args.length;
}

function namedArguments(
  action: PublicationActionDefinition,
  callbackArgs: string[],
  hasDraftId: boolean,
): Record<string, string | undefined> {
  const values = hasDraftId ? callbackArgs.slice(1) : callbackArgs;
  return Object.fromEntries(action.args.map((name, index) => [name, values[index]]));
}

async function staleCallback(ctx: Context, backendDb: BackendDb, locale: BotLocale, includeQueue: boolean): Promise<void> {
  await answerCallback(ctx, backendDb, t(locale, "action.card-stale"));
  if (includeQueue && typeof ctx.reply === "function")
    await ctx.reply(t(locale, "action.card-stale"), { reply_markup: UNKNOWN_KEYBOARD(locale) });
}

async function answerCallback(ctx: Context, backendDb: BackendDb, text?: string): Promise<void> {
  await executePublicationEffects(ctx, backendDb, [{ type: "answer-callback", ...(text ? { text } : {}) }]);
}

const MAX_TOAST_LENGTH = 200;

function toast(text: string): string {
  return text.length > MAX_TOAST_LENGTH ? `${text.slice(0, MAX_TOAST_LENGTH - 1)}…` : text;
}
