import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { resultNavigationKeyboard } from "./dialog-ui.js";
import type { BotLocale } from "./i18n.js";
import { definePostActionHandlers } from "./post-actions.js";
import {
  action,
  type PublicationActionContext,
  type PublicationActionDefinition,
  type PublicationActionResult,
} from "./publication-action-contract.js";
import type { PublicationCallback, PublicationKind } from "./publication-callback.js";
import { parseDraftId } from "./publication-callback.js";
import { publicationCardEffect } from "./publication-renderers.js";
import { defineVideoActionHandlers } from "./video-actions.js";

const sharedActions = {
  view: action(handleView, { entity: "draft", args: ["view"] }),
  retry: action(handleRetry, { entity: "draft", args: ["target", "origin"] }),
  toggle: action(handleToggle, { entity: "draft", freshCard: true, args: ["target"] }),
  cancel: action(handleCancel, { entity: "draft", freshCard: true, args: ["view"] }),
  cancel_confirm: action(handleCancelConfirm, { entity: "draft", freshCard: true, args: [] }),
  publish: action(handlePublish, { entity: "draft", freshCard: true, args: [] }),
  publish_confirm: action(handlePublishConfirm, { entity: "draft", freshCard: true, args: [] }),
  sched_pick: action(handleSchedulePick, { entity: "draft", freshCard: true, args: ["axis", "clock"] }),
  sched_manual: action(handleScheduleManual, { entity: "draft", freshCard: true, args: ["axis"] }),
  sched_confirm: action(handleScheduleConfirm, { entity: "draft", freshCard: true, args: [] }),
  cancel_dialog: action(handleCancelDialog, { entity: "session", sessionRevision: true, args: [] }),
} as const satisfies Record<string, PublicationActionDefinition>;

export const publicationActions = {
  post: { ...sharedActions, ...definePostActionHandlers(action) },
  video: { ...sharedActions, ...defineVideoActionHandlers(action) },
} as const satisfies Record<PublicationKind, Readonly<Record<string, PublicationActionDefinition>>>;

const ACTION_TABLES: Record<PublicationKind, Readonly<Record<string, PublicationActionDefinition>>> = publicationActions;

export type PublicationActionName = keyof (typeof publicationActions)[PublicationKind];

export function publicationAction(kind: PublicationKind, name: string): PublicationActionDefinition | undefined {
  return ACTION_TABLES[kind][name];
}

export function publicationActionNames(kind: PublicationKind): string[] {
  return Object.keys(publicationActions[kind]);
}

export function publicationActionArgs(kind: PublicationKind, name: string): readonly string[] | undefined {
  return publicationAction(kind, name)?.args;
}

export function isFreshPublicationAction(kind: PublicationKind, name: string): boolean {
  return publicationAction(kind, name)?.freshCard === true;
}

export function describePublicationError(locale: BotLocale, error: unknown, config: BackendConfig): string {
  if (error instanceof StudioError && error.code === "common.schedule-parse-error")
    return t(locale, "common.schedule-parse-error", { timezone: config.TIMEZONE_LABEL });
  return describeError(locale, error);
}

async function handleView(context: PublicationActionContext): Promise<PublicationActionResult> {
  const draftId = requireDraftId(context);
  const card = context.renderer.card({
    backendDb: context.backendDb,
    pipeline: context.pipeline,
    actorId: context.actorId,
    publicationId: draftId,
    config: context.config,
    locale: context.locale,
    view: context.args.view,
  });
  return publicationCardEffect(card);
}

async function handleRetry(context: PublicationActionContext): Promise<PublicationActionResult> {
  const draftId = requireDraftId(context);
  const target = context.args.target === "all" ? "" : (context.args.target ?? "");
  const result = context.pipeline.retryTarget(context.actorId, draftId, target);
  const toast = {
    type: "toast" as const,
    text: t(context.locale, "action.retry-result", { requeued: result.requeued, alreadyQueued: result.alreadyQueued }),
  };
  if (context.args.origin !== "card") return [toast];
  const card = context.renderer.card({
    backendDb: context.backendDb,
    pipeline: context.pipeline,
    actorId: context.actorId,
    publicationId: draftId,
    config: context.config,
    locale: context.locale,
  });
  return [toast, ...publicationCardEffect(card)];
}

async function handleToggle(context: PublicationActionContext): Promise<PublicationActionResult> {
  const draftId = requireDraftId(context);
  const target = context.args.target;
  if (!target) throw new StudioError("action.unknown");
  context.pipeline.toggleTarget(context.actorId, draftId, target);
  const card = context.renderer.card({
    backendDb: context.backendDb,
    pipeline: context.pipeline,
    actorId: context.actorId,
    publicationId: draftId,
    config: context.config,
    locale: context.locale,
    view: "platforms",
  });
  return [{ type: "toast", text: t(context.locale, "action.target-updated", { target }) }, ...publicationCardEffect(card)];
}

async function handleCancel(context: PublicationActionContext): Promise<PublicationActionResult> {
  const draftId = requireDraftId(context);
  const card = context.renderer.card({
    backendDb: context.backendDb,
    pipeline: context.pipeline,
    actorId: context.actorId,
    publicationId: draftId,
    config: context.config,
    locale: context.locale,
    view: context.args.view ?? "confirm_cancel",
  });
  return publicationCardEffect(card);
}

async function handleCancelConfirm(context: PublicationActionContext): Promise<PublicationActionResult> {
  const draftId = requireDraftId(context);
  context.pipeline.cancel(context.actorId, draftId);
  return [
    { type: "toast", text: t(context.locale, "action.cancelled") },
    {
      type: "screen",
      mode: "edit",
      text: t(context.locale, "action.draft-cancelled", { id: draftId }),
      options: { reply_markup: resultNavigationKeyboard(context.locale, "drafts") },
    },
  ];
}

async function handlePublish(context: PublicationActionContext): Promise<PublicationActionResult> {
  const draftId = requireDraftId(context);
  const card = context.renderer.card({
    backendDb: context.backendDb,
    pipeline: context.pipeline,
    actorId: context.actorId,
    publicationId: draftId,
    config: context.config,
    locale: context.locale,
    view: "confirm_publish",
  });
  return publicationCardEffect(card);
}

async function handlePublishConfirm(context: PublicationActionContext): Promise<PublicationActionResult> {
  const draftId = requireDraftId(context);
  context.pipeline.publish(context.actorId, draftId);
  return [{ type: "toast", text: t(context.locale, "action.queued") }];
}

async function handleSchedulePick(_context: PublicationActionContext): Promise<PublicationActionResult> {
  throw new StudioError("action.schedule-expired");
}

async function handleScheduleManual(_context: PublicationActionContext): Promise<PublicationActionResult> {
  throw new StudioError("action.schedule-expired");
}

async function handleScheduleConfirm(_context: PublicationActionContext): Promise<PublicationActionResult> {
  throw new StudioError("action.schedule-expired");
}

async function handleCancelDialog(context: PublicationActionContext): Promise<PublicationActionResult> {
  return [
    { type: "answer-callback" },
    { type: "session", operation: "clear", kind: context.callback.kind, actorId: context.actorId },
    ...(context.mainMenu ? [{ type: "main-menu", menu: context.mainMenu, edit: true } as const] : []),
  ];
}

function requireDraftId(context: PublicationActionContext): number {
  const draftId = parseDraftId(context.draftId);
  if (draftId == null) throw new StudioError(context.invalidEntityCode);
  return draftId;
}

export function logPublicationActionError(
  context: Pick<PublicationActionContext, "actorId" | "callback" | "action">,
  error: unknown,
): void {
  log("error", "Publication action failed", {
    actorId: context.actorId,
    kind: context.callback.kind,
    action: context.action,
    error,
  });
}
