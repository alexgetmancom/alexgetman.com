import { InlineKeyboard } from "grammy";
import { backFlow } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { type MessageKey, t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { manualScheduleExample } from "../foundation/time.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import type { StudioServices } from "../studio/services/index.js";
import { VIDEO_FLOW } from "../studio/video-fsm.js";
import { appendCancelButton, cancelPromptKeyboard, resultNavigationKeyboard } from "./dialog-ui.js";
import type { PublicationEffect } from "./effects.js";
import type {
  action,
  PublicationActionDefinition,
  PublicationActionResult,
  PublicationDraftActionContext,
} from "./publication-action-contract.js";
import { publicationCallback } from "./publication-callback.js";
import { advancePublicationFlow } from "./publication-flow.js";
import { publicationCardEffect, publicationRenderers } from "./publication-renderers.js";
import { callbackMessageId } from "./telegram-context.js";
import { applyVideoScheduleDate, finishVideoNow, finishVideoSchedule } from "./video-scheduling.js";
import {
  clearVideoState,
  getVideoState,
  parseVideoStep,
  saveVideoState,
  targetKeyboard,
  type VideoConversationInput,
  type VideoConversationState,
  videoPromptEffect,
  videoStepEffects,
} from "./video-ui.js";

type VideoActionArgs = PublicationDraftActionContext;
type VideoActionResult = PublicationActionResult;

const SCHEDULE_SESSION_STEPS = ["schedule_common", "schedule_target"] as const;

const EDIT_FIELDS = {
  label: { label: "video.edit-card-name", prompt: "video.edit-label-prompt" },
  youtube_title: { label: "video.edit-yt-title", prompt: "video.edit-yt-title-prompt", target: "youtube_shorts" },
  youtube_description: { label: "video.edit-yt-desc", prompt: "video.edit-yt-desc-prompt", target: "youtube_shorts" },
  youtube_game_url: { label: "video.edit-game-url", prompt: "video.edit-game-url-prompt", target: "youtube_shorts" },
  youtube_tags: { label: "video.edit-yt-tags", prompt: "video.edit-yt-tags-prompt", target: "youtube_shorts" },
  instagram_caption: { label: "video.edit-ig-caption", prompt: "video.edit-ig-caption-prompt", target: "instagram_reels" },
} as const satisfies Record<string, { label: MessageKey; prompt: MessageKey; target?: VideoTarget }>;

type EditableVideoField = keyof typeof EDIT_FIELDS;

function requireFlowStep(current: string | undefined, allowed: readonly string[], errorCode: string): void {
  if (!current || !allowed.includes(current)) throw new StudioError(errorCode);
}

/** Declares the video-only portion of the publication action registry. */
export function defineVideoActionHandlers(define: typeof action): Record<string, PublicationActionDefinition> {
  return {
    locale: define(handleLocale, { entity: "session", sessionRevision: true, args: ["locale"] }),
    cancel_dialog: define(handleCancelDialog, { entity: "session", sessionRevision: true, args: [] }),
    wizard_toggle: define(handleToggle, { entity: "session", sessionRevision: true, args: ["target"] }),
    targets_done: define(handleTargetsDone, { entity: "session", sessionRevision: true, args: [] }),
    game_skip: define(handleGameSkip, { entity: "session", sessionRevision: true, args: [] }),
    meta_back: define(handleMetaBack, { entity: "session", sessionRevision: true, args: [] }),
    schedule: define(handleScheduleStart, { entity: "draft", freshCard: true, args: [] }),
    common: define(handleScheduleMode, { entity: "draft", freshCard: true, sessionRevision: true, args: [] }),
    individual: define(handleScheduleMode, { entity: "draft", freshCard: true, sessionRevision: true, args: [] }),
    publish: define(handleNowAsk, { entity: "draft", freshCard: true, args: [] }),
    publish_confirm: define(handleNowConfirm, { entity: "draft", freshCard: true, sessionRevision: true, args: [] }),
    cancel: define(handleCancelAsk, { entity: "draft", freshCard: true, args: [] }),
    // Reachable from a standalone reminder message, not only from the card, so
    // card freshness would reject a legitimate cancellation. The service
    // validates target state instead.
    cancel_confirm: define(handleCancel, { entity: "draft", args: [] }),
    time: define(handleTime, { entity: "draft", freshCard: true, args: ["axis"] }),
    sched_pick: define(handleSchedulePick, { entity: "draft", freshCard: true, sessionRevision: true, args: ["axis", "clock"] }),
    sched_manual: define(handleScheduleManual, { entity: "draft", freshCard: true, sessionRevision: true, args: [] }),
    sched_confirm: define(handleScheduleConfirm, { entity: "draft", freshCard: true, sessionRevision: true, args: [] }),
    remove_ask: define(handleRemoveAsk, { entity: "draft", freshCard: true, args: ["target"] }),
    remove: define(handleRemove, { entity: "draft", freshCard: true, args: ["target"] }),
    edit_menu: define(handleEditMenu, { entity: "draft", freshCard: true, args: [] }),
    edit_field: define(handleEditField, { entity: "draft", freshCard: true, args: ["field"] }),
  };
}

function requireVideoTarget(value: string): VideoTarget {
  const target = parseVideoTarget(value);
  if (!target) throw new StudioError("err.unknown-platform");
  return target;
}

function parseVideoTarget(value: string): VideoTarget | null {
  return VIDEO_TARGETS.find((candidate) => candidate === value) ?? null;
}

function getVideoTargets(services: StudioServices, actorId: number, id: number): VideoTarget[] {
  return services.videos.get(actorId, id).targets.map((row) => requireVideoTarget(row.target));
}

function requireVideoSession(
  backendDb: BackendDb,
  actorId: number,
  id: number,
  steps: readonly string[],
  errorCode: string,
): VideoConversationState {
  const session = getVideoState(backendDb, actorId);
  if (!session || session.draftId !== id) throw new StudioError(errorCode);
  requireFlowStep(session.step, steps, errorCode);
  return session;
}

/** Renders an owned video draft's card in place. Used by every action that ends
 * by returning to (or refreshing) the same card. */
function showVideoCard(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  id: number,
  locale: StudioLocale,
): PublicationEffect[] {
  const card = publicationRenderers(backendDb, config).video.card({
    actorId,
    publicationId: id,
    locale,
  });
  return publicationCardEffect(card);
}

/** Asks a yes/no question on top of the draft's own card. "Back" always returns
 * to that same card, so a declined confirmation costs the operator nothing. */
function videoConfirmationEffect(
  args: Pick<VideoActionArgs, "backendDb" | "config" | "actorId" | "locale">,
  id: number,
  view: "confirm_now" | "confirm_cancel" | "confirm_remove",
  revision?: number,
  target?: VideoTarget,
): PublicationEffect[] {
  const card = publicationRenderers(args.backendDb, args.config).video.card({
    actorId: args.actorId,
    publicationId: id,
    locale: args.locale,
    view,
    revision,
    target,
  });
  return publicationCardEffect(card);
}

async function handleLocale({ backendDb, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const videoLocale = args.locale ?? "";
  const session = getVideoState(backendDb, actorId);
  requireFlowStep(session?.step, ["locale"], "err.video-restart");
  if (!session || !["ru", "en"].includes(videoLocale)) throw new StudioError("err.video-restart");
  const next = await advancePublicationFlow(
    backendDb,
    actorId,
    VIDEO_FLOW,
    session,
    videoLocale,
    { ...session.data, selectedTargets: session.selected },
    "err.video-restart",
  );
  return [
    {
      type: "screen",
      mode: "edit",
      text: t(locale, "video.dialog-prompt"),
      options: { reply_markup: cancelPromptKeyboard(locale, publicationCallback("video", "cancel_dialog"), next.revision) },
    },
  ];
}

async function handleCancelDialog({ backendDb, config, actorId, locale, mainMenu }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  clearVideoState(backendDb, actorId);
  // The draft already exists once a video file was uploaded (even mid-wizard):
  // cancel returns to that draft's own card so nothing is lost or orphaned,
  // rather than dropping into a menu with no way back to it.
  if (session?.draftId != null) {
    return showVideoCard(backendDb, config, actorId, session.draftId, locale);
  }
  if (!mainMenu) throw new StudioError("err.video-restart");
  // Cancelling is pure navigation, not a content change: turn this same
  // message into the control panel instead of deleting and sending a new one.
  return [{ type: "screen", mode: "edit", text: config.studio.displayName, options: { reply_markup: mainMenu } }];
}

async function handleToggle({ backendDb, actorId, locale, args, services }: VideoActionArgs): Promise<VideoActionResult> {
  const target = parseVideoTarget(args.target ?? "");
  const session = getVideoState(backendDb, actorId);
  requireFlowStep(session?.step, ["targets"], "err.video-restart");
  if (!session?.draftId || !target) throw new StudioError("err.video-restart");
  const selected = session.selected.includes(target) ? session.selected.filter((item) => item !== target) : [...session.selected, target];
  services.videos.toggleTarget(actorId, session.draftId, target);
  const next = saveVideoState(backendDb, actorId, { ...session, selected });
  return [{ type: "edit-reply-markup", keyboard: targetKeyboard(backendDb, selected, locale, next.revision) }];
}

async function handleTargetsDone({ backendDb, config, actorId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  requireFlowStep(session?.step, ["targets"], "err.video-pick-platform");
  if (!session?.draftId || !session.selected.length) throw new StudioError("err.video-pick-platform");
  services.videos.replaceTargets(actorId, session.draftId, session.selected);
  const next = await advancePublicationFlow(
    backendDb,
    actorId,
    VIDEO_FLOW,
    session,
    session.selected,
    { ...session.data, selectedTargets: session.selected },
    "err.video-pick-platform",
  );
  return videoStepEffects(backendDb, config, actorId, next);
}

async function handleGameSkip({ backendDb, config, actorId, locale }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  requireFlowStep(session?.step, ["youtube_game_url"], "err.video-reopen-create");
  if (!session?.draftId) throw new StudioError("err.video-reopen-create");
  const next = await advancePublicationFlow(
    backendDb,
    actorId,
    VIDEO_FLOW,
    session,
    "-",
    { ...session.data, selectedTargets: session.selected },
    "err.video-reopen-create",
  );
  return [{ type: "screen", mode: "edit", text: t(locale, "video.game-skipped") }, ...videoStepEffects(backendDb, config, actorId, next)];
}

async function handleMetaBack({ backendDb, config, actorId }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  const previous = session && backFlow(VIDEO_FLOW, session.step, { selectedTargets: session.selected });
  if (!session?.draftId || !previous) throw new StudioError("err.video-reopen-create");
  const saved = saveVideoState(backendDb, actorId, { ...session, step: previous });
  return videoStepEffects(backendDb, config, actorId, saved);
}

async function handleScheduleConfirm({ backendDb, config, actorId, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const session = requireVideoSession(backendDb, actorId, draftId, ["schedule_confirm"], "action.schedule-expired");
  const values = scheduleValues(session.data.schedule);
  if (!values) throw new StudioError("action.schedule-expired");
  return finishVideoSchedule(backendDb, config, actorId, session, videoSchedule(values), services);
}

async function handleScheduleStart({
  ctx,
  backendDb,
  config,
  actorId,
  locale,
  draftId,
  services,
}: VideoActionArgs): Promise<VideoActionResult> {
  const targets = getVideoTargets(services, actorId, draftId);
  if (!targets.length) throw new StudioError("err.video-no-platforms");
  const session = saveVideoState(backendDb, actorId, {
    draftId,
    step: "schedule_choice",
    selected: targets,
    data: {},
    controlMessageId: callbackMessageId(ctx),
  });
  const keyboard = new InlineKeyboard().text(
    t(locale, "video.same-time"),
    publicationCallback("video", "common", [draftId], session.revision),
  );
  if (targets.length > 1)
    keyboard.row().text(t(locale, "video.different-time"), publicationCallback("video", "individual", [draftId], session.revision));
  keyboard.row();
  appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), session.revision);
  const timeConfig = services.settings.timeConfig(actorId, config);
  const text = t(locale, "video.schedule-time-msk", { timezone: timeConfig.TIMEZONE_LABEL });
  const options = { parse_mode: "Markdown" as const, reply_markup: keyboard };
  if (!session.controlMessageId) return [{ type: "prompt", text, options }];
  return [{ type: "edit-message", messageId: session.controlMessageId, text, options }];
}

async function handleScheduleMode({ backendDb, config, actorId, action, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const session = requireVideoSession(backendDb, actorId, draftId, ["schedule_choice"], "err.video-reopen-publish");
  const targets = getVideoTargets(services, actorId, draftId);
  if (!targets.length) throw new StudioError("err.video-reopen-publish");
  const mode = action === "common" || action === "individual" ? action : null;
  if (!mode) throw new StudioError("err.video-reopen-publish");
  const flowData = { ...session.data, selectedTargets: targets };
  const next = await advancePublicationFlow(
    backendDb,
    actorId,
    VIDEO_FLOW,
    { ...session, data: flowData, selected: targets },
    mode,
    flowData,
    "err.video-reopen-publish",
    (data, nextStep) => {
      const first = targets[0];
      if (nextStep === "schedule_target" && !first) throw new StudioError("err.video-no-platforms");
      return nextStep === "schedule_target" ? { ...data, schedule: {}, target: first } : data;
    },
  );
  return videoStepEffects(backendDb, config, actorId, next);
}

async function handleNowAsk(actionArgs: VideoActionArgs): Promise<VideoActionResult> {
  const { ctx, backendDb, actorId, draftId } = actionArgs;
  const session = saveVideoState(backendDb, actorId, {
    draftId,
    step: "schedule_confirm",
    selected: [],
    data: {},
    controlMessageId: callbackMessageId(ctx),
  });
  return videoConfirmationEffect(actionArgs, draftId, "confirm_now", session.revision);
}

async function handleNowConfirm({ backendDb, config, actorId, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const session = requireVideoSession(backendDb, actorId, draftId, ["schedule_confirm"], "action.schedule-expired");
  return finishVideoNow(backendDb, config, actorId, session, services);
}

async function handleCancelAsk(actionArgs: VideoActionArgs): Promise<VideoActionResult> {
  return videoConfirmationEffect(actionArgs, actionArgs.draftId, "confirm_cancel");
}

async function handleRemoveAsk(actionArgs: VideoActionArgs): Promise<VideoActionResult> {
  const { draftId } = actionArgs;
  const targetText = actionArgs.args.target;
  const target = requireVideoTarget(targetText ?? "");
  return videoConfirmationEffect(actionArgs, draftId, "confirm_remove", undefined, target);
}

async function handleCancel({ backendDb, config, actorId, locale, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const result = await services.videos.cancel(actorId, draftId);
  clearVideoState(backendDb, actorId);
  const manualRemoval = result.manualRemoval
    .map(({ target, url }) => t(locale, "video.remove-manually", { label: videoTargetLabel(target), url: url ? `: ${url}` : "" }))
    .join("\n");
  const heldPrivate = result.heldPrivateYouTubeIds.length ? `\n${t(locale, "video.held-private")}` : "";
  const attention = result.holdFailures.length ? `\n${t(locale, "video.hold-failed")}` : "";
  return [
    {
      type: "screen",
      mode: "edit",
      text: `${t(locale, "video.cancelled-local", { hours: config.VIDEO_MEDIA_RETENTION_HOURS })}${heldPrivate}${attention}${manualRemoval ? `\n\n${t(locale, "video.already-published")}\n${manualRemoval}` : ""}`,
      options: { reply_markup: resultNavigationKeyboard(locale, "drafts") },
    },
  ];
}

async function handleTime({ ctx, backendDb, config, actorId, args, draftId }: VideoActionArgs): Promise<VideoActionResult> {
  const targetText = args.axis;
  const target = requireVideoTarget(targetText ?? "");
  const currentSession = getVideoState(backendDb, actorId);
  const session: VideoConversationInput = {
    draftId,
    step: "schedule_target",
    selected: [target],
    data: { target },
    controlMessageId: callbackMessageId(ctx),
    ...(currentSession ? { revision: currentSession.revision } : {}),
  };
  const saved = saveVideoState(backendDb, actorId, session);
  return videoStepEffects(backendDb, config, actorId, saved);
}

async function handleSchedulePick({
  backendDb,
  config,
  actorId,
  args,
  draftId,
  pipeline,
  services,
}: VideoActionArgs): Promise<VideoActionResult> {
  const hhmm = args.clock;
  if (pipeline.capabilities.scheduleAxis !== "target") throw new StudioError("action.schedule-expired");
  const session = requireVideoSession(backendDb, actorId, draftId, SCHEDULE_SESSION_STEPS, "action.schedule-expired");
  const value = pipeline.slotTime(actorId, `${(hhmm ?? "").slice(0, 2)}:${(hhmm ?? "").slice(2, 4)}`);
  return applyVideoScheduleDate(backendDb, config, actorId, session, value, services);
}

async function handleScheduleManual({
  backendDb,
  config,
  actorId,
  locale,
  draftId,
  services,
}: VideoActionArgs): Promise<VideoActionResult> {
  requireVideoSession(backendDb, actorId, draftId, SCHEDULE_SESSION_STEPS, "action.schedule-expired");
  const timeConfig = services.settings.timeConfig(actorId, config);
  return [
    videoPromptEffect(
      backendDb,
      actorId,
      t(locale, "video.enter-datetime", {
        timezone: timeConfig.TIMEZONE_LABEL,
        example: manualScheduleExample(timeConfig.TIMEZONE, backendDb.clock.now()),
      }),
    ),
  ];
}

async function handleRemove({ backendDb, config, actorId, locale, args, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const targetText = args.target;
  const target = requireVideoTarget(targetText ?? "");
  const { cancelled } = services.videos.removeTarget(actorId, draftId, target);
  if (cancelled) {
    clearVideoState(backendDb, actorId);
    return [
      {
        type: "screen",
        mode: "edit",
        text: t(locale, "video.all-removed"),
        options: { reply_markup: resultNavigationKeyboard(locale, "drafts") },
      },
    ];
  }
  return [
    ...showVideoCard(backendDb, config, actorId, draftId, locale),
    { type: "toast", text: t(locale, "video.removed", { label: videoTargetLabel(target) }) },
  ];
}

async function handleEditMenu({ actorId, locale, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const videos = services.videos;
  const details = videos.get(actorId, draftId);
  const canEditLabel = ["draft", "editing"].includes(details.draft.status);
  const targets = videos.metadataEditableTargets(actorId, draftId);
  const keyboard = new InlineKeyboard();
  for (const [field, definition] of Object.entries(EDIT_FIELDS) as [EditableVideoField, (typeof EDIT_FIELDS)[EditableVideoField]][]) {
    const editable = "target" in definition ? targets.includes(definition.target) : canEditLabel;
    if (editable) keyboard.text(t(locale, definition.label), publicationCallback("video", "edit_field", [draftId, field])).row();
  }
  keyboard.text(t(locale, "common.back"), publicationCallback("video", "view", [draftId, "overview"]));
  return [
    {
      type: "screen",
      mode: "edit",
      text: t(locale, "video.what-to-edit"),
      options: { parse_mode: "Markdown", reply_markup: keyboard },
      card: { kind: "video", draftId },
    },
  ];
}

async function handleEditField({ ctx, backendDb, actorId, locale, args, draftId, services }: VideoActionArgs): Promise<VideoActionResult> {
  const field = args.field ?? "";
  const definition = EDIT_FIELDS[field as EditableVideoField];
  if (!definition) throw new StudioError("err.video-reopen-edit");
  const targets = services.videos.get(actorId, draftId).targets;
  const step = parseVideoStep(field);
  if (!step) throw new StudioError("err.video-reopen-edit");
  const session: VideoConversationInput = {
    draftId,
    step,
    selected: targets.map((target) => requireVideoTarget(target.target)),
    data: { is_single_edit: true },
    controlMessageId: callbackMessageId(ctx),
  };
  saveVideoState(backendDb, actorId, session);
  return [videoPromptEffect(backendDb, actorId, t(locale, definition.prompt))];
}

function scheduleValues(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, date]) => typeof date === "string") ? Object.fromEntries(entries) : undefined;
}

function videoSchedule(values: Record<string, string>): Partial<Record<VideoTarget, Date>> {
  const schedule: Partial<Record<VideoTarget, Date>> = {};
  for (const [targetText, value] of Object.entries(values)) {
    const target = requireVideoTarget(targetText);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new StudioError("action.schedule-expired");
    schedule[target] = date;
  }
  return schedule;
}
