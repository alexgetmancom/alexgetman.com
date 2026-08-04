import { type Context, InlineKeyboard } from "grammy";
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
import { parseDraftId, publicationCallback, requireSessionStep, type VideoActionKey } from "./session-fsm.js";
import { applyVideoScheduleDate, finishVideoNow, finishVideoSchedule } from "./video-scheduling.js";
import {
  callbackMessageId,
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

type VideoActionArgs = PublicationActionContext;
type VideoActionResult = PublicationActionResult;
type VideoActionHandler = (args: PublicationActionContext) => Promise<VideoActionResult>;

const SCHEDULE_SESSION_STEPS = ["schedule_common", "schedule_target"];

const EDIT_FIELD_PROMPTS: Record<string, MessageKey> = {
  label: "video.edit-label-prompt",
  youtube_title: "video.edit-yt-title-prompt",
  youtube_description: "video.edit-yt-desc-prompt",
  youtube_game_url: "video.edit-game-url-prompt",
  youtube_tags: "video.edit-yt-tags-prompt",
  instagram_caption: "video.edit-ig-caption-prompt",
};

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
  return [
    {
      type: "screen",
      mode: "edit",
      text: preview.text,
      options: { parse_mode: "Markdown", reply_markup: preview.keyboard },
      card: { kind: "video", draftId: id },
    },
  ];
}

function startVideoEffects(ctx: Context, backendDb: BackendDb, actorId: number, locale: BotLocale): PublicationEffect[] {
  const session = saveVideoState(backendDb, actorId, { draftId: null, step: "locale", selected: [], data: {}, controlMessageId: null });
  const keyboard = new InlineKeyboard()
    .text(t(locale, "video.language-ru"), publicationCallback("video", "locale", ["ru"], session.revision))
    .text(t(locale, "video.language-en"), publicationCallback("video", "locale", ["en"], session.revision))
    .row();
  appendCancelButton(keyboard, locale, publicationCallback("video", "cancel_dialog"), session.revision);
  return [
    {
      type: "screen",
      mode: ctx.callbackQuery?.message ? "edit" : "reply",
      text: t(locale, "video.choose-language"),
      options: { reply_markup: keyboard },
    },
  ];
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
  const transition = await acceptFlow(VIDEO_FLOW, "locale", videoLocale, session.data);
  if (!transition?.next) throw new StudioError("err.video-restart");
  const next = saveVideoState(backendDb, actorId, { ...session, step: transition.next as "asset", data: transition.data });
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
  const transition = await acceptFlow(VIDEO_FLOW, "targets", session.selected, { ...session.data, selectedTargets: session.selected });
  if (!transition?.next) throw new StudioError("err.video-pick-platform");
  const next = transition.next as VideoConversationState["step"];
  const saved = saveVideoState(backendDb, actorId, { ...session, step: next, data: transition.data });
  return videoStepEffects(backendDb, config, actorId, next, saved);
}

async function handleGameSkip({ backendDb, config, actorId, locale }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, ["youtube_game_url"], "err.video-reopen-create");
  if (!session?.draftId) throw new StudioError("err.video-reopen-create");
  const transition = await acceptFlow(VIDEO_FLOW, "youtube_game_url", "-", { ...session.data, selectedTargets: session.selected });
  if (!transition?.next) throw new StudioError("err.video-reopen-create");
  const next = transition.next as VideoConversationState["step"];
  const saved = saveVideoState(backendDb, actorId, { ...session, step: next, data: transition.data });
  return [
    { type: "screen", mode: "edit", text: t(locale, "video.game-skipped") },
    ...videoStepEffects(backendDb, config, actorId, next, saved),
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
  const session = getVideoState(backendDb, actorId);
  if (!session || session.draftId !== id) throw new StudioError("action.schedule-expired");
  requireSessionStep(session.step, ["schedule_confirm"], "action.schedule-expired");
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
  const targets = createStudioServices(backendDb, config)
    .videos.get(actorId, id)
    .targets.map((row) => row.target as VideoTarget);
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
  const session = getVideoState(backendDb, actorId);
  const targets = createStudioServices(backendDb, config)
    .videos.get(actorId, id)
    .targets.map((row) => row.target as VideoTarget);
  if (!session || !targets.length) throw new StudioError("err.video-reopen-publish");
  requireSessionStep(session.step, ["schedule_choice"], "err.video-reopen-publish");
  const mode = ({ common: "common", individual: "individual" } as const)[action as "common" | "individual"];
  if (!mode) throw new StudioError("err.video-reopen-publish");
  const transition = await acceptFlow(VIDEO_FLOW, "schedule_choice", mode, { ...session.data, selectedTargets: targets });
  const nextStep = transition?.next as "schedule_common" | "schedule_target" | null;
  if (!transition || !nextStep) throw new StudioError("err.video-reopen-publish");
  const first = targets[0];
  if (nextStep === "schedule_target" && !first) throw new StudioError("err.video-no-platforms");
  const next = saveVideoState(backendDb, actorId, {
    ...session,
    draftId: id,
    selected: targets,
    step: nextStep,
    data: nextStep === "schedule_target" ? { ...transition.data, schedule: {}, target: first } : transition.data,
  });
  return videoStepEffects(backendDb, config, actorId, nextStep, next);
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
  const session = getVideoState(backendDb, actorId);
  if (!session || session.draftId !== id) throw new StudioError("action.schedule-expired");
  requireSessionStep(session.step, ["schedule_confirm"], "action.schedule-expired");
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
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, SCHEDULE_SESSION_STEPS, "action.schedule-expired");
  if (!session || session.draftId !== id) throw new StudioError("action.schedule-expired");
  const value = pipeline.slotTime(`${(hhmm ?? "").slice(0, 2)}:${(hhmm ?? "").slice(2, 4)}`);
  return applyVideoScheduleDate(backendDb, config, actorId, session, value);
}

async function handleScheduleManual({ backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, SCHEDULE_SESSION_STEPS, "action.schedule-expired");
  if (!session || session.draftId !== id) throw new StudioError("action.schedule-expired");
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
  if (canEditLabel) keyboard.text(t(locale, "video.edit-card-name"), publicationCallback("video", "edit_field", [id, "label"])).row();
  if (targets.includes("youtube_shorts")) {
    keyboard.text(t(locale, "video.edit-yt-title"), publicationCallback("video", "edit_field", [id, "youtube_title"])).row();
    keyboard.text(t(locale, "video.edit-yt-desc"), publicationCallback("video", "edit_field", [id, "youtube_description"])).row();
    keyboard.text(t(locale, "video.edit-game-url"), publicationCallback("video", "edit_field", [id, "youtube_game_url"])).row();
    keyboard.text(t(locale, "video.edit-yt-tags"), publicationCallback("video", "edit_field", [id, "youtube_tags"])).row();
  }
  if (targets.includes("instagram_reels"))
    keyboard.text(t(locale, "video.edit-ig-caption"), publicationCallback("video", "edit_field", [id, "instagram_caption"])).row();
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
  const prompt = EDIT_FIELD_PROMPTS[field];
  if (!prompt) throw new StudioError("err.video-reopen-edit");
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
  return [videoPromptEffect(backendDb, actorId, t(locale, prompt))];
}

async function handleEdit({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  const details = createStudioServices(backendDb, config).videos.get(actorId, id);
  const session: VideoConversationInput = {
    draftId: id,
    step: "label",
    selected: details.targets.map((row) => row.target as VideoTarget),
    data: {},
    controlMessageId: callbackMessageId(ctx),
  };
  saveVideoState(backendDb, actorId, session);
  return [videoPromptEffect(backendDb, actorId, t(locale, "video.edit-label-prompt"))];
}
