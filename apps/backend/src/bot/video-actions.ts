import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { withActionLock } from "../foundation/action-lock.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { describeError, type MessageKey, t } from "../interfaces/telegram/i18n/index.js";
import { videoPreview } from "../interfaces/telegram/video-preview.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { studioServices } from "../studio/services/index.js";
import { previousVideoMetadataStep, type VideoWizardStep } from "../studio/video-fsm.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { applyVideoScheduleDate, startVideoConversation } from "./video-conversation.js";
import { finishVideoNow, finishVideoSchedule } from "./video-scheduling.js";
import {
  askInstagramOrSchedule,
  callbackMessageId,
  clearSession,
  getSession,
  replyVideoPrompt,
  saveSession,
  sendVideoMetadataPrompt,
  sendVideoTimePrompt,
  setControlFromSession,
  setData,
  targetKeyboard,
  updateVideoControl,
} from "./video-session.js";

type VideoActionArgs = { ctx: Context; backendDb: BackendDb; config: BackendConfig; adminId: number; locale: BotLocale; data: string };
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

/** Ordered prefix routes. Each handler either edits/replies itself or returns a
 * toast; the caller answers the callback query exactly once either way. */
const routes: Array<{ test: (data: string) => boolean; handle: VideoActionHandler }> = [
  { test: (data) => data === "video_start", handle: handleStart },
  { test: (data) => data === "video_cancel_dialog", handle: handleCancelDialog },
  { test: (data) => data.startsWith("video_toggle:"), handle: handleToggle },
  { test: (data) => data === "video_targets_done", handle: handleTargetsDone },
  { test: (data) => data === "video_game_skip", handle: handleGameSkip },
  { test: (data) => data === "video_meta_back", handle: handleMetaBack },
  { test: (data) => data.startsWith("video_open:"), handle: handleOpen },
  { test: (data) => data.startsWith("video_retry:"), handle: handleRetry },
  { test: (data) => data.startsWith("video_schedule_confirm:"), handle: handleScheduleConfirm },
  { test: (data) => data.startsWith("video_schedule:"), handle: handleScheduleStart },
  { test: (data) => data.startsWith("video_common:") || data.startsWith("video_individual:"), handle: handleScheduleMode },
  { test: (data) => data.startsWith("video_now:"), handle: handleNowAsk },
  { test: (data) => data.startsWith("video_now_confirm:"), handle: handleNowConfirm },
  { test: (data) => data.startsWith("video_cancel_ask:"), handle: handleCancelAsk },
  { test: (data) => data.startsWith("video_remove_ask:"), handle: handleRemoveAsk },
  { test: (data) => data.startsWith("video_cancel:"), handle: handleCancel },
  { test: (data) => data.startsWith("video_time:"), handle: handleTime },
  { test: (data) => data.startsWith("video_sched_pick:"), handle: handleSchedulePick },
  { test: (data) => data.startsWith("video_sched_manual:"), handle: handleScheduleManual },
  { test: (data) => data.startsWith("video_remove:"), handle: handleRemove },
  { test: (data) => data.startsWith("video_edit_menu:"), handle: handleEditMenu },
  { test: (data) => data.startsWith("video_edit_field:"), handle: handleEditField },
  { test: (data) => data.startsWith("video_edit:"), handle: handleEdit },
];

/** Callback-only adapter: it changes a session or invokes a Studio command, never parses chat replies. */
export async function handleVideoActionCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("video_")) return false;
  const adminId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, adminId);
  try {
    const route = routes.find((candidate) => candidate.test(data));
    const result = route ? await route.handle({ ctx, backendDb, config, adminId, locale, data }) : undefined;
    if (result?.toast) await ctx.answerCallbackQuery({ text: result.toast });
    else await ctx.answerCallbackQuery();
  } catch (error) {
    await ctx.answerCallbackQuery({ text: describeError(botLocale(backendDb, adminId), error) });
  }
  return true;
}

function requireVideoTarget(value: string): VideoTarget {
  if (!VIDEO_TARGETS.includes(value as VideoTarget)) throw new StudioError("err.unknown-platform");
  return value as VideoTarget;
}

async function handleStart({ ctx, backendDb }: VideoActionArgs): Promise<VideoActionResult> {
  await startVideoConversation(ctx, backendDb);
}

async function handleCancelDialog({ ctx, backendDb, config, adminId, locale }: VideoActionArgs): Promise<VideoActionResult> {
  clearSession(backendDb, adminId);
  const keyboard = new InlineKeyboard();
  if (config.studio.modules.text_posting) keyboard.text(t(locale, "menu.new-post"), "menu_text");
  if (config.studio.modules.video_posting) keyboard.text(t(locale, "menu.new-video"), "video_start");
  keyboard.row().text(t(locale, "menu.work-queue"), "queue_home");
  if (config.studio.modules.analytics) keyboard.text(t(locale, "menu.analytics"), "analytics_home");
  const text = `${t(locale, "menu.control-panel")}:`;
  // Cancelling is pure navigation, not a content change: turn this same
  // message into the control panel instead of deleting and sending a new one.
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

async function handleToggle({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const target = data.slice("video_toggle:".length) as VideoTarget;
  const session = getSession(backendDb, adminId);
  if (!session || !VIDEO_TARGETS.includes(target)) throw new StudioError("err.video-restart");
  const selected = session.selected.includes(target) ? session.selected.filter((item) => item !== target) : [...session.selected, target];
  saveSession(backendDb, adminId, { ...session, selected });
  await ctx.editMessageReplyMarkup({ reply_markup: targetKeyboard(config, selected, locale) });
}

async function handleTargetsDone({ ctx, backendDb, config, adminId, locale }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getSession(backendDb, adminId);
  if (!session?.draftId || !session.selected.length) throw new StudioError("err.video-pick-platform");
  studioServices(backendDb, config).videos.replaceTargets(adminId, session.draftId, session.selected);
  if (session.selected.includes("youtube_shorts")) {
    const next = { ...session, step: "youtube_title" };
    saveSession(backendDb, adminId, next);
    await replyVideoPrompt(ctx, locale, t(locale, "video.prompt-yt-title"));
  } else await askInstagramOrSchedule(ctx, backendDb, adminId, session);
}

async function handleGameSkip({ ctx, backendDb, adminId, locale }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getSession(backendDb, adminId);
  if (!session?.draftId || session.step !== "youtube_game_url") throw new StudioError("err.video-reopen-create");
  setData(backendDb, adminId, session, "youtube_game_url", "", "youtube_tags");
  await ctx.editMessageText(t(locale, "video.game-skipped"));
  await sendVideoMetadataPrompt(ctx, backendDb, adminId, "youtube_tags", session.selected);
}

async function handleMetaBack({ ctx, backendDb, adminId }: VideoActionArgs): Promise<VideoActionResult> {
  const session = getSession(backendDb, adminId);
  const prevStep = session && previousVideoMetadataStep(session.step as VideoWizardStep, session.selected);
  if (!session?.draftId || !prevStep) throw new StudioError("err.video-reopen-create");
  saveSession(backendDb, adminId, { ...session, step: prevStep });
  await sendVideoMetadataPrompt(ctx, backendDb, adminId, prevStep, session.selected);
}

async function handleOpen({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = Number(data.slice("video_open:".length));
  studioServices(backendDb, config).videos.get(adminId, id);
  const preview = videoPreview(backendDb, id, locale);
  const messageId = callbackMessageId(ctx);
  if (messageId && ctx.chat?.id) setTelegramVideoCard(backendDb, id, Number(ctx.chat.id), messageId);
  await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
}

async function handleRetry({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [, targetText, idText] = data.split(":");
  const target = requireVideoTarget(targetText ?? "");
  const id = Number(idText);
  studioServices(backendDb, config).videos.retry(adminId, id, target);
  const preview = videoPreview(backendDb, id, botLocale(backendDb, adminId));
  await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  return { toast: t(locale, "video.requeued", { label: videoTargetLabel(target) }) };
}

async function handleScheduleConfirm({ ctx, backendDb, config, adminId, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = Number(data.slice("video_schedule_confirm:".length));
  const session = getSession(backendDb, adminId);
  if (!session || session.draftId !== id || session.step !== "schedule_confirm") throw new StudioError("action.schedule-expired");
  const values = session.data.schedule as Record<string, string> | undefined;
  if (!values) throw new StudioError("action.schedule-expired");
  await withActionLock(`${adminId}:${data}`, () =>
    finishVideoSchedule(
      ctx,
      backendDb,
      config,
      adminId,
      session,
      Object.fromEntries(Object.entries(values).map(([target, value]) => [target, new Date(value)])) as Partial<Record<VideoTarget, Date>>,
    ),
  );
}

async function handleScheduleStart({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = Number(data.slice("video_schedule:".length));
  const targets = studioServices(backendDb, config)
    .videos.get(adminId, id)
    .targets.map((row) => row.target as VideoTarget);
  if (!targets.length) throw new StudioError("err.video-no-platforms");
  const keyboard = new InlineKeyboard().text(t(locale, "video.same-time"), `video_common:${id}`);
  if (targets.length > 1) keyboard.row().text(t(locale, "video.different-time"), `video_individual:${id}`);
  const session = { draftId: id, step: "schedule_choice", selected: targets, data: { controlMessageId: callbackMessageId(ctx) } };
  saveSession(backendDb, adminId, session);
  setControlFromSession(backendDb, id, ctx, session);
  await updateVideoControl(ctx, session, t(locale, "video.schedule-time-msk"), keyboard, locale);
}

async function handleScheduleMode({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = Number(data.split(":")[1]);
  const session = getSession(backendDb, adminId);
  const targets = studioServices(backendDb, config)
    .videos.get(adminId, id)
    .targets.map((row) => row.target as VideoTarget);
  if (!session || !targets.length) throw new StudioError("err.video-reopen-publish");
  if (data.startsWith("video_common:")) {
    const next = { ...session, draftId: id, selected: targets, step: "schedule_common" };
    saveSession(backendDb, adminId, next);
    await sendVideoTimePrompt(ctx, backendDb, adminId, next, t(locale, "video.enter-datetime"));
    return;
  }
  const first = targets[0];
  if (!first) throw new StudioError("err.video-no-platforms");
  const next = {
    ...session,
    draftId: id,
    selected: targets,
    step: `schedule_target:${first}`,
    data: { ...session.data, schedule: {} },
  };
  saveSession(backendDb, adminId, next);
  await sendVideoTimePrompt(ctx, backendDb, adminId, next, t(locale, "video.schedule-target-prompt", { target: videoTargetLabel(first) }));
}

async function handleNowAsk({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = Number(data.slice("video_now:".length));
  studioServices(backendDb, config).videos.get(adminId, id);
  const preview = videoPreview(backendDb, id, locale);
  await ctx.editMessageText(`${preview.text}\n\n${t(locale, "video.publish-now-q")}`, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard()
      .text(t(locale, "video.publish-now-yes"), `video_now_confirm:${id}`)
      .text(t(locale, "common.back"), `video_open:${id}`),
  });
}

async function handleNowConfirm({ ctx, backendDb, config, adminId, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = Number(data.slice("video_now_confirm:".length));
  await withActionLock(`${adminId}:${data}`, () =>
    finishVideoNow(ctx, backendDb, config, adminId, {
      draftId: id,
      step: "",
      selected: [],
      data: { controlMessageId: callbackMessageId(ctx) },
    }),
  );
}

async function handleCancelAsk({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = Number(data.slice("video_cancel_ask:".length));
  studioServices(backendDb, config).videos.get(adminId, id);
  const preview = videoPreview(backendDb, id, locale);
  await ctx.editMessageText(
    `${preview.text}\n\n⚠️ *${t(locale, "vpreview.cancel-confirm-q")}*\n${t(locale, "vpreview.cancel-confirm-warn")}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text(t(locale, "vpreview.cancel-yes"), `video_cancel:${id}`)
        .text(t(locale, "common.back"), `video_open:${id}`),
    },
  );
}

async function handleRemoveAsk({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [, targetText, idText] = data.split(":");
  const target = requireVideoTarget(targetText ?? "");
  const id = Number(idText);
  studioServices(backendDb, config).videos.get(adminId, id);
  const label = videoTargetLabel(target);
  const preview = videoPreview(backendDb, id, locale);
  await ctx.editMessageText(
    `${preview.text}\n\n⚠️ *${t(locale, "vpreview.remove-confirm-q", { target: label })}*\n${t(locale, "vpreview.remove-confirm-warn", { target: label })}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text(t(locale, "vpreview.remove-yes", { target: label }), `video_remove:${target}:${id}`)
        .text(t(locale, "common.back"), `video_open:${id}`),
    },
  );
}

async function handleCancel({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const result = await withActionLock(`${adminId}:${data}`, () =>
    studioServices(backendDb, config).videos.cancel(adminId, Number(data.slice("video_cancel:".length))),
  );
  if (!result.ok) return;
  clearSession(backendDb, adminId);
  const manualRemoval = result.value.manualRemoval
    .map(({ target, url }) => t(locale, "video.remove-manually", { label: videoTargetLabel(target), url: url ? `: ${url}` : "" }))
    .join("\n");
  const heldPrivate = result.value.heldPrivateYouTubeIds.length ? `\n${t(locale, "video.held-private")}` : "";
  const attention = result.value.holdFailures.length ? `\n${t(locale, "video.hold-failed")}` : "";
  await ctx.editMessageText(
    `${t(locale, "video.cancelled-local", { hours: config.VIDEO_MEDIA_RETENTION_HOURS })}${heldPrivate}${attention}${manualRemoval ? `\n\n${t(locale, "video.already-published")}\n${manualRemoval}` : ""}`,
    { reply_markup: new InlineKeyboard().text(t(locale, "common.menu"), "menu_home") },
  );
}

async function handleTime({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [, targetText, idText] = data.split(":");
  const target = requireVideoTarget(targetText ?? "");
  const id = Number(idText);
  studioServices(backendDb, config).videos.get(adminId, id);
  const session = {
    draftId: id,
    step: `schedule_target:${target}`,
    selected: [target],
    data: { controlMessageId: callbackMessageId(ctx) },
  };
  saveSession(backendDb, adminId, session);
  setControlFromSession(backendDb, id, ctx, session);
  await sendVideoTimePrompt(
    ctx,
    backendDb,
    adminId,
    session,
    t(locale, "video.schedule-target-prompt", { target: videoTargetLabel(target) }),
  );
}

async function handleSchedulePick({ ctx, backendDb, config, adminId, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [, hhmm, idText] = data.split(":");
  const id = Number(idText);
  const session = getSession(backendDb, adminId);
  if (!session || session.draftId !== id || !(session.step === "schedule_common" || session.step.startsWith("schedule_target:")))
    throw new StudioError("action.schedule-expired");
  const value = studioServices(backendDb, config).videos.slotTime(`${(hhmm ?? "").slice(0, 2)}:${(hhmm ?? "").slice(2, 4)}`);
  await applyVideoScheduleDate(ctx, backendDb, config, adminId, session, value);
}

async function handleScheduleManual({ ctx, backendDb, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = Number(data.slice("video_sched_manual:".length));
  const session = getSession(backendDb, adminId);
  if (!session || session.draftId !== id || !(session.step === "schedule_common" || session.step.startsWith("schedule_target:")))
    throw new StudioError("action.schedule-expired");
  await replyVideoPrompt(ctx, locale, t(locale, "video.enter-datetime"));
}

async function handleRemove({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [, targetText, idText] = data.split(":");
  const target = requireVideoTarget(targetText ?? "");
  const id = Number(idText);
  const result = await withActionLock(`${adminId}:${data}`, async () =>
    studioServices(backendDb, config).videos.removeTarget(adminId, id, target),
  );
  if (!result.ok) return;
  const { cancelled } = result.value;
  if (cancelled) {
    clearSession(backendDb, adminId);
    await ctx.editMessageText(t(locale, "video.all-removed"), {
      reply_markup: new InlineKeyboard().text(t(locale, "common.menu"), "menu_home"),
    });
    return;
  }
  const preview = videoPreview(backendDb, id, botLocale(backendDb, adminId));
  await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  return { toast: t(locale, "video.removed", { label: videoTargetLabel(target) }) };
}

async function handleEditMenu({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = Number(data.slice("video_edit_menu:".length));
  const targets = studioServices(backendDb, config)
    .videos.get(adminId, id)
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

async function handleEditField({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const [, field = "", idText] = data.split(":");
  if (!Object.hasOwn(EDIT_FIELD_PROMPTS, field)) throw new StudioError("err.video-reopen-edit");
  const id = Number(idText);
  const targets = studioServices(backendDb, config).videos.get(adminId, id).targets;
  const session = {
    draftId: id,
    step: field,
    selected: targets.map((target) => target.target as VideoTarget),
    data: { controlMessageId: callbackMessageId(ctx), is_single_edit: true },
  };
  saveSession(backendDb, adminId, session);
  setControlFromSession(backendDb, id, ctx, session);
  await replyVideoPrompt(ctx, locale, t(locale, EDIT_FIELD_PROMPTS[field] ?? "video.edit-generic-prompt"));
}

async function handleEdit({ ctx, backendDb, config, adminId, locale, data }: VideoActionArgs): Promise<VideoActionResult> {
  const id = Number(data.slice("video_edit:".length));
  const details = studioServices(backendDb, config).videos.get(adminId, id);
  const session = {
    draftId: id,
    step: "label",
    selected: details.targets.map((row) => row.target as VideoTarget),
    data: { controlMessageId: callbackMessageId(ctx) },
  };
  saveSession(backendDb, adminId, session);
  setControlFromSession(backendDb, id, ctx, session);
  await replyVideoPrompt(ctx, locale, t(locale, "video.edit-label-prompt"));
}
