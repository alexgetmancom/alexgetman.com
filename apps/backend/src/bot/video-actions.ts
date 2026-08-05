import { InlineKeyboard } from "grammy";
import { acceptFlow, backFlow } from "../application/conversation-flow.js";
import type { PublicationPipeline } from "../application/publication-pipeline.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { type MessageKey, t } from "../foundation/i18n/index.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { createStudioServices } from "../studio/services/index.js";
import { VIDEO_FLOW } from "../studio/video-fsm.js";
import { appendCancelButton, cancelPromptKeyboard, confirmationKeyboard, resultNavigationKeyboard } from "./dialog-ui.js";
import type { PublicationEffect } from "./effects.js";
import type { BotLocale } from "./i18n.js";
import type { PublicationActionContext, PublicationActionResult } from "./publication-action-types.js";
import { renderPublicationCard } from "./publication-card.js";
import { publicationCardEffect } from "./publication-card-effects.js";
import { parseDraftId, publicationCallback, requireSessionStep, type VideoActionKey } from "./session-fsm.js";
import { callbackMessageId } from "./telegram-context.js";
import { applyVideoScheduleDate, finishVideoNow, finishVideoSchedule } from "./video-scheduling.js";
import {
  clearVideoState,
  getVideoState,
  parseVideoStep,
  saveVideoState,
  startVideoEffects,
  targetKeyboard,
  type VideoConversationInput,
  type VideoConversationState,
  videoPromptEffect,
  videoStepEffects,
} from "./video-ui.js";

type VideoActionArgs = PublicationActionContext;
type VideoActionResult = PublicationActionResult;
type VideoActionHandler = (args: PublicationActionContext) => Promise<VideoActionResult>;

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

/** Routed by the action token before the first ":" (or the whole string, for
 * bare actions). Exact-match keys, so unlike prefix/startsWith matching, no
 * entry can accidentally shadow another and their declaration order is free. */
export const videoActionHandlers: Record<VideoActionKey, VideoActionHandler> = {
  start: handleStart,
  locale: handleLocale,
  cancel_dialog: handleCancelDialog,
  toggle: handleToggle,
  targets_done: handleTargetsDone,
  game_skip: handleGameSkip,
  meta_back: handleMetaBack,
  open: handleOpen,
  retry: handleRetry,
  cancel_notice: handleCancel,
  schedule_confirm: handleScheduleConfirm,
  sched_confirm: handleScheduleConfirm,
  schedule: handleScheduleStart,
  common: handleScheduleMode,
  individual: handleScheduleMode,
  now: handleNowAsk,
  now_confirm: handleNowConfirm,
  cancel_ask: handleCancelAsk,
  remove_ask: handleRemoveAsk,
  cancel: handleCancel,
  time: handleTime,
  sched_pick: handleSchedulePick,
  sched_manual: handleScheduleManual,
  remove: handleRemove,
  edit_menu: handleEditMenu,
  edit_field: handleEditField,
  edit: handleEdit,
};

function requireVideoTarget(value: string): VideoTarget {
  if (!VIDEO_TARGETS.includes(value as VideoTarget)) throw new StudioError("err.unknown-platform");
  return value as VideoTarget;
}

function requireDraftId(value: string | undefined): number {
  const id = parseDraftId(value);
  if (id == null) throw new StudioError("err.video-reopen-create");
  return id;
}

function getVideoTargets(backendDb: BackendDb, config: BackendConfig, actorId: number, id: number): VideoTarget[] {
  return createStudioServices(backendDb, config)
    .videos.get(actorId, id)
    .targets.map((row) => row.target as VideoTarget);
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
  requireSessionStep(session.step, steps, errorCode);
  return session;
}

async function advanceVideoFlow(
  backendDb: BackendDb,
  actorId: number,
  session: VideoConversationState,
  stepName: string,
  input: unknown,
  errorCode: string,
  decorateData?: (data: Record<string, unknown>, nextStep: VideoConversationState["step"]) => Record<string, unknown>,
): Promise<VideoConversationState> {
  const transition = await acceptFlow(VIDEO_FLOW, stepName, input, { ...session.data, selectedTargets: session.selected });
  if (!transition?.next) throw new StudioError(errorCode);
  const nextStep = transition.next as VideoConversationState["step"];
  const data = decorateData ? decorateData(transition.data, nextStep) : transition.data;
  return saveVideoState(backendDb, actorId, { ...session, step: nextStep, data });
}

/** Renders an owned video draft's card in place. Used by every action that ends
 * by returning to (or refreshing) the same card. */
function showVideoCard(
  pipeline: PublicationPipeline,
  config: BackendConfig,
  actorId: number,
  id: number,
  locale: BotLocale,
): PublicationEffect[] {
  const preview = renderPublicationCard("video", {
    data: pipeline.preview(actorId, id),
    config,
    locale,
  });
  return publicationCardEffect("video", id, preview);
}

/** Asks a yes/no question on top of the draft's own card. "Back" always returns
 * to that same card, so a declined confirmation costs the operator nothing. */
function videoConfirmationEffects(
  args: Pick<VideoActionArgs, "config" | "actorId" | "locale" | "pipeline">,
  id: number,
  question: string,
  confirm: { label: string; callback: string },
  revision?: number,
): PublicationEffect[] {
  const { config, actorId, locale, pipeline } = args;
  const preview = renderPublicationCard("video", { data: pipeline.preview(actorId, id), config, locale });
  return [
    {
      type: "screen",
      mode: "edit",
      text: `${preview.text}\n\n${question}`,
      options: {
        parse_mode: "Markdown",
        reply_markup: confirmationKeyboard(
          confirm,
          { label: t(locale, "common.back"), callback: publicationCallback("video", "open", [id]) },
          revision,
        ),
      },
      card: { kind: "video", draftId: id },
    },
  ];
}

function existingVideoControlEffect(session: VideoConversationState, text: string, keyboard: InlineKeyboard): PublicationEffect[] {
  if (!session.controlMessageId) return [{ type: "prompt", text, options: { parse_mode: "Markdown", reply_markup: keyboard } }];
  return [{ type: "edit-message", messageId: session.controlMessageId, text, options: { parse_mode: "Markdown", reply_markup: keyboard } }];
}

async function handleStart({ ctx, backendDb, actorId, locale }: VideoActionArgs): Promise<VideoActionResult> {
  return startVideoEffects(ctx, backendDb, actorId, locale);
}

async function handleLocale({ backendDb, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const videoLocale = args[0] ?? "";
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, ["locale"], "err.video-restart");
  if (!session || !["ru", "en"].includes(videoLocale)) throw new StudioError("err.video-restart");
  const next = await advanceVideoFlow(backendDb, actorId, session, "locale", videoLocale, "err.video-restart");
  return [
    {
      type: "screen",
      mode: "edit",
      text: t(locale, "video.dialog-prompt"),
      options: { reply_markup: cancelPromptKeyboard(locale, publicationCallback("video", "cancel_dialog"), next.revision) },
    },
  ];
}

async function handleCancelDialog({ backendDb, config, actorId, locale, mainMenu, pipeline }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  clearVideoState(backendDb, actorId);
  // The draft already exists once a video file was uploaded (even mid-wizard):
  // cancel returns to that draft's own card so nothing is lost or orphaned,
  // rather than dropping into a menu with no way back to it.
  if (session?.draftId != null) {
    return showVideoCard(pipeline, config, actorId, session.draftId, locale);
  }
  if (!mainMenu) throw new StudioError("err.video-restart");
  // Cancelling is pure navigation, not a content change: turn this same
  // message into the control panel instead of deleting and sending a new one.
  return [{ type: "screen", mode: "edit", text: t(locale, "menu.control-panel"), options: { reply_markup: mainMenu } }];
}

async function handleToggle({ backendDb, config, actorId, locale, args, pipeline }: VideoActionArgs): Promise<VideoActionResult> {
  const target = args[0] as VideoTarget;
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, ["targets"], "err.video-restart");
  if (!session?.draftId || !VIDEO_TARGETS.includes(target)) throw new StudioError("err.video-restart");
  const selected = session.selected.includes(target) ? session.selected.filter((item) => item !== target) : [...session.selected, target];
  pipeline.toggleTarget(actorId, session.draftId, target);
  const next = saveVideoState(backendDb, actorId, { ...session, selected });
  return [{ type: "edit-reply-markup", keyboard: targetKeyboard(config, selected, locale, next.revision) }];
}

async function handleTargetsDone({ backendDb, config, actorId }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, ["targets"], "err.video-pick-platform");
  if (!session?.draftId || !session.selected.length) throw new StudioError("err.video-pick-platform");
  createStudioServices(backendDb, config).videos.replaceTargets(actorId, session.draftId, session.selected);
  const next = await advanceVideoFlow(backendDb, actorId, session, "targets", session.selected, "err.video-pick-platform");
  return videoStepEffects(backendDb, config, actorId, next.step, next);
}

async function handleGameSkip({ backendDb, config, actorId, locale }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, ["youtube_game_url"], "err.video-reopen-create");
  if (!session?.draftId) throw new StudioError("err.video-reopen-create");
  const next = await advanceVideoFlow(backendDb, actorId, session, "youtube_game_url", "-", "err.video-reopen-create");
  return [
    { type: "screen", mode: "edit", text: t(locale, "video.game-skipped") },
    ...videoStepEffects(backendDb, config, actorId, next.step, next),
  ];
}

async function handleMetaBack({ backendDb, config, actorId }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  const previous = session && backFlow(VIDEO_FLOW, session.step, { selectedTargets: session.selected });
  if (!session?.draftId || !previous) throw new StudioError("err.video-reopen-create");
  const step = previous as VideoConversationState["step"];
  const saved = saveVideoState(backendDb, actorId, { ...session, step });
  return videoStepEffects(backendDb, config, actorId, step, saved);
}

async function handleOpen({ config, actorId, locale, args, pipeline }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  pipeline.get(actorId, id);
  return showVideoCard(pipeline, config, actorId, id, locale);
}

async function handleRetry({ config, actorId, locale, args, pipeline }: VideoActionArgs): Promise<VideoActionResult> {
  const [idText, targetText] = args;
  const target = requireVideoTarget(targetText ?? "");
  const id = requireDraftId(idText);
  pipeline.retryTarget(actorId, id, target);
  return [
    ...showVideoCard(pipeline, config, actorId, id, locale),
    { type: "toast", text: t(locale, "video.requeued", { label: videoTargetLabel(target) }) },
  ];
}

async function handleScheduleConfirm({ backendDb, config, actorId, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  const session = requireVideoSession(backendDb, actorId, id, ["schedule_confirm"], "action.schedule-expired");
  const values = session.data.schedule as Record<string, string> | undefined;
  if (!values) throw new StudioError("action.schedule-expired");
  return finishVideoSchedule(
    backendDb,
    config,
    actorId,
    session,
    Object.fromEntries(Object.entries(values).map(([target, value]) => [target, new Date(value)])) as Partial<Record<VideoTarget, Date>>,
  );
}

async function handleScheduleStart({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  const targets = getVideoTargets(backendDb, config, actorId, id);
  if (!targets.length) throw new StudioError("err.video-no-platforms");
  const session = saveVideoState(backendDb, actorId, {
    draftId: id,
    step: "schedule_choice",
    selected: targets,
    data: {},
    controlMessageId: callbackMessageId(ctx),
  });
  const keyboard = new InlineKeyboard().text(t(locale, "video.same-time"), publicationCallback("video", "common", [id], session.revision));
  if (targets.length > 1)
    keyboard.row().text(t(locale, "video.different-time"), publicationCallback("video", "individual", [id], session.revision));
  keyboard.row();
  appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), session.revision);
  return existingVideoControlEffect(session, t(locale, "video.schedule-time-msk", { timezone: config.TIMEZONE_LABEL }), keyboard);
}

async function handleScheduleMode({ backendDb, config, actorId, action, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  const session = requireVideoSession(backendDb, actorId, id, ["schedule_choice"], "err.video-reopen-publish");
  const targets = getVideoTargets(backendDb, config, actorId, id);
  if (!targets.length) throw new StudioError("err.video-reopen-publish");
  const mode = ({ common: "common", individual: "individual" } as const)[action as "common" | "individual"];
  if (!mode) throw new StudioError("err.video-reopen-publish");
  const next = await advanceVideoFlow(
    backendDb,
    actorId,
    { ...session, selected: targets },
    "schedule_choice",
    mode,
    "err.video-reopen-publish",
    (data, nextStep) => {
      const first = targets[0];
      if (nextStep === "schedule_target" && !first) throw new StudioError("err.video-no-platforms");
      return nextStep === "schedule_target" ? { ...data, schedule: {}, target: first } : data;
    },
  );
  return videoStepEffects(backendDb, config, actorId, next.step, next);
}

async function handleNowAsk(actionArgs: VideoActionArgs): Promise<VideoActionResult> {
  const { ctx, backendDb, actorId, locale, args, pipeline } = actionArgs;
  const id = requireDraftId(args[0]);
  pipeline.get(actorId, id);
  const session = saveVideoState(backendDb, actorId, {
    draftId: id,
    step: "schedule_confirm",
    selected: [],
    data: {},
    controlMessageId: callbackMessageId(ctx),
  });
  return videoConfirmationEffects(
    actionArgs,
    id,
    t(locale, "video.publish-now-q"),
    { label: t(locale, "video.publish-now-yes"), callback: publicationCallback("video", "now_confirm", [id]) },
    session.revision,
  );
}

async function handleNowConfirm({ backendDb, config, actorId, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  const session = requireVideoSession(backendDb, actorId, id, ["schedule_confirm"], "action.schedule-expired");
  return finishVideoNow(backendDb, config, actorId, session);
}

async function handleCancelAsk(actionArgs: VideoActionArgs): Promise<VideoActionResult> {
  const { actorId, locale, args, pipeline } = actionArgs;
  const id = requireDraftId(args[0]);
  pipeline.get(actorId, id);
  return videoConfirmationEffects(
    actionArgs,
    id,
    `⚠️ *${t(locale, "vpreview.cancel-confirm-q")}*\n${t(locale, "vpreview.cancel-confirm-warn")}`,
    { label: t(locale, "vpreview.cancel-yes"), callback: publicationCallback("video", "cancel", [id]) },
  );
}

async function handleRemoveAsk(actionArgs: VideoActionArgs): Promise<VideoActionResult> {
  const { actorId, locale, args, pipeline } = actionArgs;
  const [idText, targetText] = args;
  const target = requireVideoTarget(targetText ?? "");
  const id = requireDraftId(idText);
  pipeline.get(actorId, id);
  const label = videoTargetLabel(target);
  return videoConfirmationEffects(
    actionArgs,
    id,
    `⚠️ *${t(locale, "vpreview.remove-confirm-q", { target: label })}*\n${t(locale, "vpreview.remove-confirm-warn", { target: label })}`,
    { label: t(locale, "vpreview.remove-yes", { target: label }), callback: publicationCallback("video", "remove", [id, target]) },
  );
}

async function handleCancel({ backendDb, config, actorId, locale, args, pipeline }: VideoActionArgs): Promise<VideoActionResult> {
  const result = (await pipeline.cancel(actorId, requireDraftId(args[0]))) as {
    manualRemoval: Array<{ target: VideoTarget; url: string | null }>;
    heldPrivateYouTubeIds: string[];
    holdFailures: string[];
  };
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

async function handleTime({ ctx, backendDb, config, actorId, args, pipeline }: VideoActionArgs): Promise<VideoActionResult> {
  const [idText, targetText] = args;
  const target = requireVideoTarget(targetText ?? "");
  const id = requireDraftId(idText);
  pipeline.get(actorId, id);
  const currentSession = getVideoState(backendDb, actorId);
  const session: VideoConversationInput = {
    draftId: id,
    step: "schedule_target",
    selected: [target],
    data: { target },
    controlMessageId: callbackMessageId(ctx),
    ...(currentSession ? { revision: currentSession.revision } : {}),
  };
  const saved = saveVideoState(backendDb, actorId, session);
  return videoStepEffects(backendDb, config, actorId, "schedule_target", saved);
}

async function handleSchedulePick({ backendDb, config, actorId, args, pipeline }: VideoActionArgs): Promise<VideoActionResult> {
  const [idText, hhmm] = args;
  const id = requireDraftId(idText);
  if (pipeline.capabilities.scheduleAxis !== "target") throw new StudioError("action.schedule-expired");
  const session = requireVideoSession(backendDb, actorId, id, SCHEDULE_SESSION_STEPS, "action.schedule-expired");
  const value = pipeline.slotTime(`${(hhmm ?? "").slice(0, 2)}:${(hhmm ?? "").slice(2, 4)}`);
  return applyVideoScheduleDate(backendDb, config, actorId, session, value);
}

async function handleScheduleManual({ backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  requireVideoSession(backendDb, actorId, id, SCHEDULE_SESSION_STEPS, "action.schedule-expired");
  return [videoPromptEffect(backendDb, actorId, t(locale, "video.enter-datetime", { timezone: config.TIMEZONE_LABEL }))];
}

async function handleRemove({ backendDb, config, actorId, locale, args, pipeline }: VideoActionArgs): Promise<VideoActionResult> {
  const [idText, targetText] = args;
  const target = requireVideoTarget(targetText ?? "");
  const id = requireDraftId(idText);
  const { cancelled } = pipeline.removeTarget(actorId, id, target) as { cancelled: boolean };
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
    ...showVideoCard(pipeline, config, actorId, id, locale),
    { type: "toast", text: t(locale, "video.removed", { label: videoTargetLabel(target) }) },
  ];
}

async function handleEditMenu({ backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  const videos = createStudioServices(backendDb, config).videos;
  const details = videos.get(actorId, id);
  const canEditLabel = ["draft", "editing"].includes(details.draft.status);
  const targets = videos.metadataEditableTargets(actorId, id);
  const keyboard = new InlineKeyboard();
  const addField = (field: EditableVideoField): void => {
    keyboard.text(t(locale, EDIT_FIELDS[field].label), publicationCallback("video", "edit_field", [id, field])).row();
  };
  if (canEditLabel) addField("label");
  for (const field of ["youtube_title", "youtube_description", "youtube_game_url", "youtube_tags"] as const)
    if (targets.includes(EDIT_FIELDS[field].target)) addField(field);
  if (targets.includes(EDIT_FIELDS.instagram_caption.target)) addField("instagram_caption");
  keyboard.text(t(locale, "common.back"), publicationCallback("video", "open", [id]));
  return [
    {
      type: "screen",
      mode: "edit",
      text: t(locale, "video.what-to-edit"),
      options: { parse_mode: "Markdown", reply_markup: keyboard },
      card: { kind: "video", draftId: id },
    },
  ];
}

async function handleEditField({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const [idText, field = ""] = args;
  const definition = EDIT_FIELDS[field as EditableVideoField];
  if (!definition) throw new StudioError("err.video-reopen-edit");
  const id = requireDraftId(idText);
  const targets = createStudioServices(backendDb, config).videos.get(actorId, id).targets;
  const step = parseVideoStep(field);
  if (!step) throw new StudioError("err.video-reopen-edit");
  const session: VideoConversationInput = {
    draftId: id,
    step,
    selected: targets.map((target) => target.target as VideoTarget),
    data: { is_single_edit: true },
    controlMessageId: callbackMessageId(ctx),
  };
  saveVideoState(backendDb, actorId, session);
  return [videoPromptEffect(backendDb, actorId, t(locale, definition.prompt))];
}

async function handleEdit({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  const session: VideoConversationInput = {
    draftId: id,
    step: "label",
    selected: getVideoTargets(backendDb, config, actorId, id),
    data: {},
    controlMessageId: callbackMessageId(ctx),
  };
  saveVideoState(backendDb, actorId, session);
  return [videoPromptEffect(backendDb, actorId, t(locale, "video.edit-label-prompt"))];
}
