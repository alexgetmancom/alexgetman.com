import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { type MessageKey, t } from "../foundation/i18n/index.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { videoPreview } from "../interfaces/telegram/video-preview.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { createStudioServices } from "../studio/services/index.js";
import { acceptVideoFlowStep, previousVideoMetadataStep, type VideoWizardStep } from "../studio/video-fsm.js";
import { withCallbackActionLock } from "./callback-action.js";
import type { PublicationActionContext } from "./callback-router.js";
import { appendCancelButton, cancelPromptKeyboard, confirmationKeyboard, resultNavigationKeyboard } from "./dialog-ui.js";
import type { BotLocale } from "./i18n.js";
import { showMainMenu } from "./menu-render.js";
import { parseDraftId, publicationCallback, requireSessionStep, type VideoActionKey } from "./session-fsm.js";
import { applyVideoScheduleDate, startVideoConversation } from "./video-conversation.js";
import { finishVideoNow, finishVideoSchedule } from "./video-scheduling.js";
import {
  askInstagramOrSchedule,
  callbackMessageId,
  clearVideoState,
  getVideoState,
  parseVideoStep,
  replyVideoPrompt,
  saveVideoState,
  sendVideoMetadataPrompt,
  sendVideoTimePrompt,
  setControlFromSession,
  targetKeyboard,
  updateVideoControl,
  type VideoConversationInput,
  type VideoConversationState,
} from "./video-ui.js";

type VideoActionArgs = PublicationActionContext;
// biome-ignore lint/suspicious/noConfusingVoidType: handlers use bare `return;` on every no-toast path; `void` is what makes that a valid Promise<VideoActionResult>.
type VideoActionResult = { toast?: string } | void;
type VideoActionHandler = (args: PublicationActionContext) => Promise<VideoActionResult>;

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
async function showVideoCard(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  id: number,
  locale: BotLocale,
): Promise<void> {
  const preview = videoPreview(createStudioServices(backendDb, config).videos.preview(actorId, id), config, locale);
  await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  const messageId = callbackMessageId(ctx);
  if (messageId && ctx.chat?.id) setTelegramVideoCard(backendDb, id, Number(ctx.chat.id), messageId);
}

async function handleStart({ ctx, backendDb }: VideoActionArgs): Promise<VideoActionResult> {
  await startVideoConversation(ctx, backendDb);
}

async function handleLocale({ ctx, backendDb, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const videoLocale = args[0] ?? "";
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, ["locale"], "err.video-restart");
  if (!session || !["ru", "en"].includes(videoLocale)) throw new StudioError("err.video-restart");
  const transition = await acceptVideoFlowStep("locale", videoLocale, session.data);
  if (!transition?.next) throw new StudioError("err.video-restart");
  const next = saveVideoState(backendDb, actorId, { ...session, step: transition.next as "asset", data: transition.data });
  await ctx.editMessageText(t(locale, "video.dialog-prompt"), {
    reply_markup: cancelPromptKeyboard(locale, publicationCallback("video", "cancel_dialog"), next.revision),
  });
}

async function handleCancelDialog({ ctx, backendDb, config, actorId, locale, mainMenu }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  clearVideoState(backendDb, actorId);
  // The draft already exists once a video file was uploaded (even mid-wizard):
  // cancel returns to that draft's own card so nothing is lost or orphaned,
  // rather than dropping into a menu with no way back to it.
  if (session?.draftId != null) {
    try {
      await showVideoCard(ctx, backendDb, config, actorId, session.draftId, locale);
      return;
    } catch {}
  }
  if (!mainMenu) throw new StudioError("err.video-restart");
  // Cancelling is pure navigation, not a content change: turn this same
  // message into the control panel instead of deleting and sending a new one.
  try {
    await showMainMenu(ctx, backendDb, mainMenu, true);
  } catch {
    await showMainMenu(ctx, backendDb, mainMenu);
  }
}

async function handleToggle({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const target = args[0] as VideoTarget;
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, ["targets"], "err.video-restart");
  if (!session || !VIDEO_TARGETS.includes(target)) throw new StudioError("err.video-restart");
  const selected = session.selected.includes(target) ? session.selected.filter((item) => item !== target) : [...session.selected, target];
  const next = saveVideoState(backendDb, actorId, { ...session, selected });
  await ctx.editMessageReplyMarkup({ reply_markup: targetKeyboard(config, selected, locale, next.revision) });
}

async function handleTargetsDone({ ctx, backendDb, config, actorId }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, ["targets"], "err.video-pick-platform");
  if (!session?.draftId || !session.selected.length) throw new StudioError("err.video-pick-platform");
  createStudioServices(backendDb, config).videos.replaceTargets(actorId, session.draftId, session.selected);
  const transition = await acceptVideoFlowStep("targets", session.selected, { ...session.data, selectedTargets: session.selected });
  if (!transition?.next) throw new StudioError("err.video-pick-platform");
  const next = saveVideoState(backendDb, actorId, {
    ...session,
    step: transition.next as VideoConversationState["step"],
    data: transition.data,
  });
  if (transition.next === "youtube_title" || transition.next === "instagram_caption") {
    await sendVideoMetadataPrompt(ctx, backendDb, actorId, transition.next, session.selected);
  } else await askInstagramOrSchedule(ctx, backendDb, config, actorId, next);
}

async function handleGameSkip({ ctx, backendDb, actorId, locale }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, ["youtube_game_url"], "err.video-reopen-create");
  if (!session?.draftId) throw new StudioError("err.video-reopen-create");
  const transition = await acceptVideoFlowStep("youtube_game_url", "-", { ...session.data, selectedTargets: session.selected });
  if (!transition?.next) throw new StudioError("err.video-reopen-create");
  saveVideoState(backendDb, actorId, { ...session, step: transition.next as VideoConversationState["step"], data: transition.data });
  await ctx.editMessageText(t(locale, "video.game-skipped"));
  await sendVideoMetadataPrompt(ctx, backendDb, actorId, "youtube_tags", session.selected);
}

async function handleMetaBack({ ctx, backendDb, actorId }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getVideoState(backendDb, actorId);
  const prevStep = session && previousVideoMetadataStep(session.step as VideoWizardStep, session.selected);
  if (!session?.draftId || !prevStep) throw new StudioError("err.video-reopen-create");
  saveVideoState(backendDb, actorId, { ...session, step: prevStep });
  await sendVideoMetadataPrompt(ctx, backendDb, actorId, prevStep, session.selected);
}

async function handleOpen({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  createStudioServices(backendDb, config).videos.get(actorId, id);
  const messageId = callbackMessageId(ctx);
  if (messageId && ctx.chat?.id) setTelegramVideoCard(backendDb, id, Number(ctx.chat.id), messageId);
  await showVideoCard(ctx, backendDb, config, actorId, id, locale);
}

async function handleRetry({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const [idText, targetText] = args;
  const target = requireVideoTarget(targetText ?? "");
  const id = requireDraftId(idText);
  createStudioServices(backendDb, config).videos.retry(actorId, id, target);
  await showVideoCard(ctx, backendDb, config, actorId, id, locale);
  return { toast: t(locale, "video.requeued", { label: videoTargetLabel(target) }) };
}

async function handleScheduleConfirm({ ctx, backendDb, config, actorId, args, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  const session = getVideoState(backendDb, actorId);
  if (!session || session.draftId !== id) throw new StudioError("action.schedule-expired");
  requireSessionStep(session.step, ["schedule_confirm"], "action.schedule-expired");
  const values = session.data.schedule as Record<string, string> | undefined;
  if (!values) throw new StudioError("action.schedule-expired");
  await withCallbackActionLock(ctx, `${actorId}:${data}`, () =>
    finishVideoSchedule(
      ctx,
      backendDb,
      config,
      actorId,
      session,
      Object.fromEntries(Object.entries(values).map(([target, value]) => [target, new Date(value)])) as Partial<Record<VideoTarget, Date>>,
    ),
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
  setControlFromSession(backendDb, id, ctx, session);
  await updateVideoControl(ctx, session, t(locale, "video.schedule-time-msk", { timezone: config.TIMEZONE_LABEL }), keyboard, locale);
}

async function handleScheduleMode({ ctx, backendDb, config, actorId, locale, action, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  const session = getVideoState(backendDb, actorId);
  const targets = createStudioServices(backendDb, config)
    .videos.get(actorId, id)
    .targets.map((row) => row.target as VideoTarget);
  if (!session || !targets.length) throw new StudioError("err.video-reopen-publish");
  requireSessionStep(session.step, ["schedule_choice"], "err.video-reopen-publish");
  const mode = ({ common: "common", individual: "individual" } as const)[action as "common" | "individual"];
  if (!mode) throw new StudioError("err.video-reopen-publish");
  const transition = await acceptVideoFlowStep("schedule_choice", mode, { ...session.data, selectedTargets: targets });
  const nextStep = transition?.next as "schedule_common" | "schedule_target" | null;
  if (!transition || !nextStep) throw new StudioError("err.video-reopen-publish");
  const first = targets[0];
  const next = saveVideoState(backendDb, actorId, {
    ...session,
    draftId: id,
    selected: targets,
    step: nextStep,
    data: nextStep === "schedule_target" ? { ...transition.data, schedule: {}, target: first } : transition.data,
  });
  const prompt = {
    schedule_common: () => t(locale, "video.enter-datetime", { timezone: config.TIMEZONE_LABEL }),
    schedule_target: () => {
      if (!first) throw new StudioError("err.video-no-platforms");
      return t(locale, "video.schedule-target-prompt", { target: videoTargetLabel(first), timezone: config.TIMEZONE_LABEL });
    },
  }[nextStep];
  await sendVideoTimePrompt(ctx, backendDb, actorId, next, prompt());
}

async function handleNowAsk({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  createStudioServices(backendDb, config).videos.get(actorId, id);
  const session = saveVideoState(backendDb, actorId, {
    draftId: id,
    step: "schedule_confirm",
    selected: [],
    data: {},
    controlMessageId: callbackMessageId(ctx),
  });
  const preview = videoPreview(createStudioServices(backendDb, config).videos.preview(actorId, id), config, locale);
  await ctx.editMessageText(`${preview.text}\n\n${t(locale, "video.publish-now-q")}`, {
    parse_mode: "Markdown",
    reply_markup: confirmationKeyboard(
      { label: t(locale, "video.publish-now-yes"), callback: publicationCallback("video", "now_confirm", [id]) },
      { label: t(locale, "common.back"), callback: publicationCallback("video", "open", [id]) },
      session.revision,
    ),
  });
}

async function handleNowConfirm({ ctx, backendDb, config, actorId, args, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  const session = getVideoState(backendDb, actorId);
  if (!session || session.draftId !== id) throw new StudioError("action.schedule-expired");
  requireSessionStep(session.step, ["schedule_confirm"], "action.schedule-expired");
  await withCallbackActionLock(ctx, `${actorId}:${data}`, () => finishVideoNow(ctx, backendDb, config, actorId, session));
}

async function handleCancelAsk({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  createStudioServices(backendDb, config).videos.get(actorId, id);
  const preview = videoPreview(createStudioServices(backendDb, config).videos.preview(actorId, id), config, locale);
  await ctx.editMessageText(
    `${preview.text}\n\n⚠️ *${t(locale, "vpreview.cancel-confirm-q")}*\n${t(locale, "vpreview.cancel-confirm-warn")}`,
    {
      parse_mode: "Markdown",
      reply_markup: confirmationKeyboard(
        { label: t(locale, "vpreview.cancel-yes"), callback: publicationCallback("video", "cancel", [id]) },
        { label: t(locale, "common.back"), callback: publicationCallback("video", "open", [id]) },
      ),
    },
  );
}

async function handleRemoveAsk({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const [idText, targetText] = args;
  const target = requireVideoTarget(targetText ?? "");
  const id = requireDraftId(idText);
  createStudioServices(backendDb, config).videos.get(actorId, id);
  const label = videoTargetLabel(target);
  const preview = videoPreview(createStudioServices(backendDb, config).videos.preview(actorId, id), config, locale);
  await ctx.editMessageText(
    `${preview.text}\n\n⚠️ *${t(locale, "vpreview.remove-confirm-q", { target: label })}*\n${t(locale, "vpreview.remove-confirm-warn", { target: label })}`,
    {
      parse_mode: "Markdown",
      reply_markup: confirmationKeyboard(
        { label: t(locale, "vpreview.remove-yes", { target: label }), callback: publicationCallback("video", "remove", [id, target]) },
        { label: t(locale, "common.back"), callback: publicationCallback("video", "open", [id]) },
      ),
    },
  );
}

async function handleCancel({ ctx, backendDb, config, actorId, locale, args, data }: VideoActionArgs): Promise<VideoActionResult> {
  const result = await withCallbackActionLock(ctx, `${actorId}:${data}`, () =>
    createStudioServices(backendDb, config).videos.cancel(actorId, requireDraftId(args[0])),
  );
  if (!result.ok) return;
  clearVideoState(backendDb, actorId);
  const manualRemoval = result.value.manualRemoval
    .map(({ target, url }) => t(locale, "video.remove-manually", { label: videoTargetLabel(target), url: url ? `: ${url}` : "" }))
    .join("\n");
  const heldPrivate = result.value.heldPrivateYouTubeIds.length ? `\n${t(locale, "video.held-private")}` : "";
  const attention = result.value.holdFailures.length ? `\n${t(locale, "video.hold-failed")}` : "";
  await ctx.editMessageText(
    `${t(locale, "video.cancelled-local", { hours: config.VIDEO_MEDIA_RETENTION_HOURS })}${heldPrivate}${attention}${manualRemoval ? `\n\n${t(locale, "video.already-published")}\n${manualRemoval}` : ""}`,
    {
      reply_markup: resultNavigationKeyboard(locale, "drafts"),
    },
  );
}

async function handleTime({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const [idText, targetText] = args;
  const target = requireVideoTarget(targetText ?? "");
  const id = requireDraftId(idText);
  createStudioServices(backendDb, config).videos.get(actorId, id);
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
  setControlFromSession(backendDb, id, ctx, saved);
  await sendVideoTimePrompt(
    ctx,
    backendDb,
    actorId,
    saved,
    t(locale, "video.schedule-target-prompt", { target: videoTargetLabel(target), timezone: config.TIMEZONE_LABEL }),
  );
}

async function handleSchedulePick({ ctx, backendDb, config, actorId, args }: VideoActionArgs): Promise<VideoActionResult> {
  const [idText, hhmm] = args;
  const id = requireDraftId(idText);
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, scheduleSessionSteps(), "action.schedule-expired");
  if (!session || session.draftId !== id) throw new StudioError("action.schedule-expired");
  const value = createStudioServices(backendDb, config).videos.slotTime(`${(hhmm ?? "").slice(0, 2)}:${(hhmm ?? "").slice(2, 4)}`);
  await applyVideoScheduleDate(ctx, backendDb, config, actorId, session, value);
}

async function handleScheduleManual({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(args[0]);
  const session = getVideoState(backendDb, actorId);
  requireSessionStep(session?.step, scheduleSessionSteps(), "action.schedule-expired");
  if (!session || session.draftId !== id) throw new StudioError("action.schedule-expired");
  await replyVideoPrompt(ctx, backendDb, actorId, locale, t(locale, "video.enter-datetime", { timezone: config.TIMEZONE_LABEL }));
}

function scheduleSessionSteps(): string[] {
  return ["schedule_common", "schedule_target"];
}

async function handleRemove({ ctx, backendDb, config, actorId, locale, args, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [idText, targetText] = args;
  const target = requireVideoTarget(targetText ?? "");
  const id = requireDraftId(idText);
  const result = await withCallbackActionLock(ctx, `${actorId}:${data}`, async () =>
    createStudioServices(backendDb, config).videos.removeTarget(actorId, id, target),
  );
  if (!result.ok) return;
  const { cancelled } = result.value;
  if (cancelled) {
    clearVideoState(backendDb, actorId);
    await ctx.editMessageText(t(locale, "video.all-removed"), {
      reply_markup: resultNavigationKeyboard(locale, "drafts"),
    });
    return;
  }
  await showVideoCard(ctx, backendDb, config, actorId, id, locale);
  return { toast: t(locale, "video.removed", { label: videoTargetLabel(target) }) };
}

async function handleEditMenu({ ctx, backendDb, config, actorId, locale, args }: VideoActionArgs): Promise<VideoActionResult> {
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
  await ctx.editMessageText(t(locale, "video.what-to-edit"), { parse_mode: "Markdown", reply_markup: keyboard });
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
  const saved = saveVideoState(backendDb, actorId, session);
  setControlFromSession(backendDb, id, ctx, saved);
  await replyVideoPrompt(ctx, backendDb, actorId, locale, t(locale, prompt));
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
  const saved = saveVideoState(backendDb, actorId, session);
  setControlFromSession(backendDb, id, ctx, saved);
  await replyVideoPrompt(ctx, backendDb, actorId, locale, t(locale, "video.edit-label-prompt"));
}
