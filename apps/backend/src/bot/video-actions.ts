import type { Menu } from "@grammyjs/menu";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { describeError, type MessageKey, t } from "../foundation/i18n/index.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { videoPreview } from "../interfaces/telegram/video-preview.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { createStudioServices } from "../studio/services/index.js";
import { previousVideoMetadataStep, type VideoWizardStep } from "../studio/video-fsm.js";
import { withCallbackActionLock } from "./callback-action.js";
import { createCallbackRouter } from "./callback-router.js";
import { isStaleCardCallback, VIDEO_CARD_FRESHNESS } from "./card-freshness.js";
import { appendCancelButton, cancelPromptKeyboard, confirmationKeyboard, resultNavigationKeyboard } from "./dialog-ui.js";
import type { BotLocale } from "./i18n.js";
import { showMainMenu } from "./menu-render.js";
import { requireSessionStep, versionedCallback } from "./session-fsm.js";
import { applyVideoScheduleDate, startVideoConversation } from "./video-conversation.js";
import { VIDEO_ACTION_KEYS, type VideoActionKey } from "./video-routes.js";
import { finishVideoNow, finishVideoSchedule } from "./video-scheduling.js";
import {
  askInstagramOrSchedule,
  callbackMessageId,
  clearSession,
  getSession,
  parseVideoSessionStep,
  replyVideoPrompt,
  saveSession,
  sendVideoMetadataPrompt,
  sendVideoTimePrompt,
  setControlFromSession,
  setData,
  targetKeyboard,
  updateVideoControl,
  type VideoSession,
} from "./video-session.js";

type VideoActionArgs = {
  ctx: Context;
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  locale: BotLocale;
  data: string;
  mainMenu: Menu<Context> | undefined;
};
// biome-ignore lint/suspicious/noConfusingVoidType: handlers use bare `return;` on every no-toast path; `void` is what makes that a valid Promise<VideoActionResult>.
type VideoActionResult = { toast?: string } | void;
type VideoActionHandler = (args: VideoActionArgs) => Promise<VideoActionResult>;

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
const routes: Record<VideoActionKey, VideoActionHandler> = {
  video_start: handleStart,
  video_locale: handleLocale,
  video_cancel_dialog: handleCancelDialog,
  video_toggle: handleToggle,
  video_targets_done: handleTargetsDone,
  video_game_skip: handleGameSkip,
  video_meta_back: handleMetaBack,
  video_open: handleOpen,
  video_retry: handleRetry,
  video_cancel_notice: handleCancel,
  video_schedule_confirm: handleScheduleConfirm,
  video_schedule: handleScheduleStart,
  video_common: handleScheduleMode,
  video_individual: handleScheduleMode,
  video_now: handleNowAsk,
  video_now_confirm: handleNowConfirm,
  video_cancel_ask: handleCancelAsk,
  video_remove_ask: handleRemoveAsk,
  video_cancel: handleCancel,
  video_time: handleTime,
  video_sched_pick: handleSchedulePick,
  video_sched_manual: handleScheduleManual,
  video_remove: handleRemove,
  video_edit_menu: handleEditMenu,
  video_edit_field: handleEditField,
  video_edit: handleEdit,
};

/** The routed video callback names, so the callback-wiring test can check every
 * `video_` button the bot renders against the real map instead of a copy. */
export const videoRouteKeys: readonly string[] = VIDEO_ACTION_KEYS;

const SESSION_BOUND_VIDEO_ACTIONS = new Set([
  "video_locale",
  "video_cancel_dialog",
  "video_toggle",
  "video_targets_done",
  "video_game_skip",
  "video_meta_back",
  "video_schedule_confirm",
  "video_now_confirm",
  "video_common",
  "video_individual",
  "video_sched_pick",
  "video_sched_manual",
]);

/** Telegram rejects a callback answer longer than this, which would turn the
 * error path itself into an unanswered callback: a spinner and no explanation.
 * External API failures reach describeError as raw provider text of any length. */
const MAX_TOAST_LENGTH = 200;

function toast(text: string): string {
  return text.length > MAX_TOAST_LENGTH ? `${text.slice(0, MAX_TOAST_LENGTH - 1)}…` : text;
}

function createVideoCallbackRouter(mainMenu?: Menu<Context>) {
  return createCallbackRouter<VideoActionArgs, undefined, VideoActionResult>({
    prefix: "video_",
    routes,
    sessionBound: SESSION_BOUND_VIDEO_ACTIONS,
    currentSessionRevision: ({ backendDb, actorId }) => getSession(backendDb, actorId)?.revision,
    buildArgs: (common) => ({ ...common, mainMenu }),
    isStale: ({ ctx, backendDb, data }) => isStaleCardCallback(ctx, backendDb, data, VIDEO_CARD_FRESHNESS),
    staleText: (locale) => t(locale, "action.card-stale"),
    unknownText: (locale) => t(locale, "action.unknown"),
    onResult: async ({ ctx }, result) => {
      await ctx.answerCallbackQuery(result?.toast ? { text: toast(result.toast) } : undefined);
    },
    onError: async ({ ctx, locale }, error) => {
      await ctx.answerCallbackQuery({ text: toast(describeError(locale, error)) });
    },
  });
}

/** Callback-only adapter: it changes a session or invokes a Studio command, never parses chat replies. */
export async function handleVideoActionCallback(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  mainMenu?: Menu<Context>,
): Promise<boolean> {
  return createVideoCallbackRouter(mainMenu)(ctx, backendDb, config);
}

function requireVideoTarget(value: string): VideoTarget {
  if (!VIDEO_TARGETS.includes(value as VideoTarget)) throw new StudioError("err.unknown-platform");
  return value as VideoTarget;
}

function requireDraftId(value: string | undefined): number {
  const id = Number(value);
  if (!value || !Number.isInteger(id) || id <= 0) throw new StudioError("err.video-reopen-create");
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

async function handleLocale({ ctx, backendDb, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const videoLocale = data.slice("video_locale:".length);
  const session = getSession(backendDb, actorId);
  requireSessionStep(session?.step, ["locale"], "err.video-restart");
  if (!session || !["ru", "en"].includes(videoLocale)) throw new StudioError("err.video-restart");
  const next = saveSession(backendDb, actorId, { ...session, step: "asset", data: { ...session.data, videoLocale } });
  await ctx.editMessageText(t(locale, "video.dialog-prompt"), {
    reply_markup: cancelPromptKeyboard(locale, "video_cancel_dialog", next.revision),
  });
}

async function handleCancelDialog({ ctx, backendDb, config, actorId, locale, mainMenu }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getSession(backendDb, actorId);
  clearSession(backendDb, actorId);
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

async function handleToggle({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const target = data.slice("video_toggle:".length) as VideoTarget;
  const session = getSession(backendDb, actorId);
  requireSessionStep(session?.step, ["targets"], "err.video-restart");
  if (!session || !VIDEO_TARGETS.includes(target)) throw new StudioError("err.video-restart");
  const selected = session.selected.includes(target) ? session.selected.filter((item) => item !== target) : [...session.selected, target];
  const next = saveSession(backendDb, actorId, { ...session, selected });
  await ctx.editMessageReplyMarkup({ reply_markup: targetKeyboard(config, selected, locale, next.revision) });
}

async function handleTargetsDone({ ctx, backendDb, config, actorId, locale }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getSession(backendDb, actorId);
  requireSessionStep(session?.step, ["targets"], "err.video-pick-platform");
  if (!session?.draftId || !session.selected.length) throw new StudioError("err.video-pick-platform");
  createStudioServices(backendDb, config).videos.replaceTargets(actorId, session.draftId, session.selected);
  if (session.selected.includes("youtube_shorts")) {
    saveSession(backendDb, actorId, { ...session, step: "youtube_title" });
    await replyVideoPrompt(ctx, backendDb, actorId, locale, t(locale, "video.prompt-yt-title"));
  } else await askInstagramOrSchedule(ctx, backendDb, config, actorId, session);
}

async function handleGameSkip({ ctx, backendDb, actorId, locale }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getSession(backendDb, actorId);
  requireSessionStep(session?.step, ["youtube_game_url"], "err.video-reopen-create");
  if (!session?.draftId) throw new StudioError("err.video-reopen-create");
  setData(backendDb, actorId, session, "youtube_game_url", "", "youtube_tags");
  await ctx.editMessageText(t(locale, "video.game-skipped"));
  await sendVideoMetadataPrompt(ctx, backendDb, actorId, "youtube_tags", session.selected);
}

async function handleMetaBack({ ctx, backendDb, actorId }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getSession(backendDb, actorId);
  const prevStep = session && previousVideoMetadataStep(session.step as VideoWizardStep, session.selected);
  if (!session?.draftId || !prevStep) throw new StudioError("err.video-reopen-create");
  saveSession(backendDb, actorId, { ...session, step: prevStep });
  await sendVideoMetadataPrompt(ctx, backendDb, actorId, prevStep, session.selected);
}

async function handleOpen({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(data.slice("video_open:".length));
  createStudioServices(backendDb, config).videos.get(actorId, id);
  const messageId = callbackMessageId(ctx);
  if (messageId && ctx.chat?.id) setTelegramVideoCard(backendDb, id, Number(ctx.chat.id), messageId);
  await showVideoCard(ctx, backendDb, config, actorId, id, locale);
}

async function handleRetry({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [, targetText, idText] = data.split(":");
  const target = requireVideoTarget(targetText ?? "");
  const id = requireDraftId(idText);
  createStudioServices(backendDb, config).videos.retry(actorId, id, target);
  await showVideoCard(ctx, backendDb, config, actorId, id, locale);
  return { toast: t(locale, "video.requeued", { label: videoTargetLabel(target) }) };
}

async function handleScheduleConfirm({ ctx, backendDb, config, actorId, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(data.slice("video_schedule_confirm:".length));
  const session = getSession(backendDb, actorId);
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

async function handleScheduleStart({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(data.slice("video_schedule:".length));
  const targets = createStudioServices(backendDb, config)
    .videos.get(actorId, id)
    .targets.map((row) => row.target as VideoTarget);
  if (!targets.length) throw new StudioError("err.video-no-platforms");
  const session = saveSession(backendDb, actorId, {
    draftId: id,
    step: "schedule_choice",
    selected: targets,
    data: { controlMessageId: callbackMessageId(ctx) },
  });
  const keyboard = new InlineKeyboard().text(t(locale, "video.same-time"), versionedCallback(`video_common:${id}`, session.revision));
  if (targets.length > 1)
    keyboard.row().text(t(locale, "video.different-time"), versionedCallback(`video_individual:${id}`, session.revision));
  keyboard.row();
  appendCancelButton(keyboard, locale, "video_cancel_dialog", session.revision);
  setControlFromSession(backendDb, id, ctx, session);
  await updateVideoControl(ctx, session, t(locale, "video.schedule-time-msk", { timezone: config.TIMEZONE_LABEL }), keyboard, locale);
}

async function handleScheduleMode({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(data.split(":")[1]);
  const session = getSession(backendDb, actorId);
  const targets = createStudioServices(backendDb, config)
    .videos.get(actorId, id)
    .targets.map((row) => row.target as VideoTarget);
  if (!session || !targets.length) throw new StudioError("err.video-reopen-publish");
  requireSessionStep(session.step, ["schedule_choice"], "err.video-reopen-publish");
  if (data.startsWith("video_common:")) {
    const next = saveSession(backendDb, actorId, { ...session, draftId: id, selected: targets, step: "schedule_common" });
    await sendVideoTimePrompt(ctx, backendDb, actorId, next, t(locale, "video.enter-datetime", { timezone: config.TIMEZONE_LABEL }));
    return;
  }
  const first = targets[0];
  if (!first) throw new StudioError("err.video-no-platforms");
  const next = saveSession(backendDb, actorId, {
    ...session,
    draftId: id,
    selected: targets,
    step: `schedule_target:${first}`,
    data: { ...session.data, schedule: {} },
  });
  await sendVideoTimePrompt(
    ctx,
    backendDb,
    actorId,
    next,
    t(locale, "video.schedule-target-prompt", { target: videoTargetLabel(first), timezone: config.TIMEZONE_LABEL }),
  );
}

async function handleNowAsk({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(data.slice("video_now:".length));
  createStudioServices(backendDb, config).videos.get(actorId, id);
  const session = saveSession(backendDb, actorId, {
    draftId: id,
    step: "schedule_confirm",
    selected: [],
    data: { controlMessageId: callbackMessageId(ctx) },
  });
  const preview = videoPreview(createStudioServices(backendDb, config).videos.preview(actorId, id), config, locale);
  await ctx.editMessageText(`${preview.text}\n\n${t(locale, "video.publish-now-q")}`, {
    parse_mode: "Markdown",
    reply_markup: confirmationKeyboard(
      { label: t(locale, "video.publish-now-yes"), callback: `video_now_confirm:${id}` },
      { label: t(locale, "common.back"), callback: `video_open:${id}` },
      session.revision,
    ),
  });
}

async function handleNowConfirm({ ctx, backendDb, config, actorId, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(data.slice("video_now_confirm:".length));
  const session = getSession(backendDb, actorId);
  if (!session || session.draftId !== id) throw new StudioError("action.schedule-expired");
  requireSessionStep(session.step, ["schedule_confirm"], "action.schedule-expired");
  await withCallbackActionLock(ctx, `${actorId}:${data}`, () => finishVideoNow(ctx, backendDb, config, actorId, session));
}

async function handleCancelAsk({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(data.slice("video_cancel_ask:".length));
  createStudioServices(backendDb, config).videos.get(actorId, id);
  const preview = videoPreview(createStudioServices(backendDb, config).videos.preview(actorId, id), config, locale);
  await ctx.editMessageText(
    `${preview.text}\n\n⚠️ *${t(locale, "vpreview.cancel-confirm-q")}*\n${t(locale, "vpreview.cancel-confirm-warn")}`,
    {
      parse_mode: "Markdown",
      reply_markup: confirmationKeyboard(
        { label: t(locale, "vpreview.cancel-yes"), callback: `video_cancel:${id}` },
        { label: t(locale, "common.back"), callback: `video_open:${id}` },
      ),
    },
  );
}

async function handleRemoveAsk({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [, targetText, idText] = data.split(":");
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
        { label: t(locale, "vpreview.remove-yes", { target: label }), callback: `video_remove:${target}:${id}` },
        { label: t(locale, "common.back"), callback: `video_open:${id}` },
      ),
    },
  );
}

async function handleCancel({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const prefix = data.startsWith("video_cancel_notice:") ? "video_cancel_notice:" : "video_cancel:";
  const result = await withCallbackActionLock(ctx, `${actorId}:${data}`, () =>
    createStudioServices(backendDb, config).videos.cancel(actorId, requireDraftId(data.slice(prefix.length))),
  );
  if (!result.ok) return;
  clearSession(backendDb, actorId);
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

async function handleTime({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [, targetText, idText] = data.split(":");
  const target = requireVideoTarget(targetText ?? "");
  const id = requireDraftId(idText);
  createStudioServices(backendDb, config).videos.get(actorId, id);
  const session: VideoSession = {
    draftId: id,
    step: `schedule_target:${target}` as const,
    selected: [target],
    data: { controlMessageId: callbackMessageId(ctx) },
    revision: getSession(backendDb, actorId)?.revision ?? 0,
  };
  const saved = saveSession(backendDb, actorId, session);
  setControlFromSession(backendDb, id, ctx, saved);
  await sendVideoTimePrompt(
    ctx,
    backendDb,
    actorId,
    saved,
    t(locale, "video.schedule-target-prompt", { target: videoTargetLabel(target), timezone: config.TIMEZONE_LABEL }),
  );
}

async function handleSchedulePick({ ctx, backendDb, config, actorId, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [, hhmm, idText] = data.split(":");
  const id = requireDraftId(idText);
  const session = getSession(backendDb, actorId);
  requireSessionStep(session?.step, scheduleSessionSteps(), "action.schedule-expired");
  if (!session || session.draftId !== id) throw new StudioError("action.schedule-expired");
  const value = createStudioServices(backendDb, config).videos.slotTime(`${(hhmm ?? "").slice(0, 2)}:${(hhmm ?? "").slice(2, 4)}`);
  await applyVideoScheduleDate(ctx, backendDb, config, actorId, session, value);
}

async function handleScheduleManual({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(data.slice("video_sched_manual:".length));
  const session = getSession(backendDb, actorId);
  requireSessionStep(session?.step, scheduleSessionSteps(), "action.schedule-expired");
  if (!session || session.draftId !== id) throw new StudioError("action.schedule-expired");
  await replyVideoPrompt(ctx, backendDb, actorId, locale, t(locale, "video.enter-datetime", { timezone: config.TIMEZONE_LABEL }));
}

function scheduleSessionSteps(): string[] {
  return ["schedule_common", ...VIDEO_TARGETS.map((target) => `schedule_target:${target}`)];
}

async function handleRemove({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [, targetText, idText] = data.split(":");
  const target = requireVideoTarget(targetText ?? "");
  const id = requireDraftId(idText);
  const result = await withCallbackActionLock(ctx, `${actorId}:${data}`, async () =>
    createStudioServices(backendDb, config).videos.removeTarget(actorId, id, target),
  );
  if (!result.ok) return;
  const { cancelled } = result.value;
  if (cancelled) {
    clearSession(backendDb, actorId);
    await ctx.editMessageText(t(locale, "video.all-removed"), {
      reply_markup: resultNavigationKeyboard(locale, "drafts"),
    });
    return;
  }
  await showVideoCard(ctx, backendDb, config, actorId, id, locale);
  return { toast: t(locale, "video.removed", { label: videoTargetLabel(target) }) };
}

async function handleEditMenu({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(data.slice("video_edit_menu:".length));
  const targets = createStudioServices(backendDb, config)
    .videos.get(actorId, id)
    .targets.map((target) => target.target as VideoTarget);
  const keyboard = new InlineKeyboard().text(t(locale, "video.edit-card-name"), `video_edit_field:label:${id}`).row();
  if (targets.includes("youtube_shorts")) {
    keyboard.text(t(locale, "video.edit-yt-title"), `video_edit_field:youtube_title:${id}`).row();
    keyboard.text(t(locale, "video.edit-yt-desc"), `video_edit_field:youtube_description:${id}`).row();
    keyboard.text(t(locale, "video.edit-game-url"), `video_edit_field:youtube_game_url:${id}`).row();
    keyboard.text(t(locale, "video.edit-yt-tags"), `video_edit_field:youtube_tags:${id}`).row();
  }
  if (targets.includes("instagram_reels"))
    keyboard.text(t(locale, "video.edit-ig-caption"), `video_edit_field:instagram_caption:${id}`).row();
  keyboard.text(t(locale, "common.back"), `video_open:${id}`);
  await ctx.editMessageText(t(locale, "video.what-to-edit"), { parse_mode: "Markdown", reply_markup: keyboard });
}

async function handleEditField({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [, field = "", idText] = data.split(":");
  const prompt = EDIT_FIELD_PROMPTS[field];
  if (!prompt) throw new StudioError("err.video-reopen-edit");
  const id = requireDraftId(idText);
  const targets = createStudioServices(backendDb, config).videos.get(actorId, id).targets;
  const step = parseVideoSessionStep(field);
  if (!step) throw new StudioError("err.video-reopen-edit");
  const session: import("./video-session.js").VideoSessionInput = {
    draftId: id,
    step,
    selected: targets.map((target) => target.target as VideoTarget),
    data: { controlMessageId: callbackMessageId(ctx), is_single_edit: true },
  };
  const saved = saveSession(backendDb, actorId, session);
  setControlFromSession(backendDb, id, ctx, saved);
  await replyVideoPrompt(ctx, backendDb, actorId, locale, t(locale, prompt));
}

async function handleEdit({ ctx, backendDb, config, actorId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = requireDraftId(data.slice("video_edit:".length));
  const details = createStudioServices(backendDb, config).videos.get(actorId, id);
  const session: import("./video-session.js").VideoSessionInput = {
    draftId: id,
    step: "label",
    selected: details.targets.map((row) => row.target as VideoTarget),
    data: { controlMessageId: callbackMessageId(ctx) },
  };
  const saved = saveSession(backendDb, actorId, session);
  setControlFromSession(backendDb, id, ctx, saved);
  await replyVideoPrompt(ctx, backendDb, actorId, locale, t(locale, "video.edit-label-prompt"));
}
