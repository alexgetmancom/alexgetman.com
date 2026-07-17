import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { describeError, type MessageKey, t } from "../interfaces/telegram/i18n/index.js";
import { videoPreview } from "../interfaces/telegram/video-preview.js";
import { VIDEO_TARGETS, type VideoTarget, videoTargetLabel } from "../publishing/video-types.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale } from "./i18n.js";
import { startVideoConversation } from "./video-conversation.js";
import { finishVideoNow, finishVideoSchedule } from "./video-scheduling.js";
import {
  askInstagramOrSchedule,
  callbackMessageId,
  clearSession,
  getSession,
  replyVideoPrompt,
  saveSession,
  setControlFromSession,
  setData,
  targetKeyboard,
  updateVideoControl,
} from "./video-session.js";

/** Callback-only adapter: it changes a session or invokes a Studio command, never parses chat replies. */
export async function handleVideoActionCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("video_")) return false;
  const adminId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, adminId);
  try {
    if (data === "video_start") await startVideoConversation(ctx, backendDb);
    else if (data === "video_cancel_dialog") {
      clearSession(backendDb, adminId);
      await ctx.answerCallbackQuery();
      try {
        await ctx.deleteMessage();
      } catch {}
      const keyboard = new InlineKeyboard();
      if (config.studio.modules.text_posting) keyboard.text(t(locale, "menu.new-post"), "menu_text");
      if (config.studio.modules.video_posting) keyboard.text(t(locale, "menu.new-video"), "video_start");
      keyboard.row().text(t(locale, "menu.work-queue"), "queue_home");
      if (config.studio.modules.analytics) keyboard.text(t(locale, "menu.analytics"), "analytics_home");
      await ctx.reply(`${t(locale, "menu.control-panel")}:`, { reply_markup: keyboard });
      return true;
    } else if (data.startsWith("video_toggle:")) {
      const target = data.slice("video_toggle:".length) as VideoTarget;
      const session = getSession(backendDb, adminId);
      if (!session || !VIDEO_TARGETS.includes(target)) throw new StudioError("err.video-restart");
      const selected = session.selected.includes(target)
        ? session.selected.filter((item) => item !== target)
        : [...session.selected, target];
      saveSession(backendDb, adminId, { ...session, selected });
      await ctx.editMessageReplyMarkup({ reply_markup: targetKeyboard(config, selected, locale) });
    } else if (data === "video_targets_done") {
      const session = getSession(backendDb, adminId);
      if (!session?.draftId || !session.selected.length) throw new StudioError("err.video-pick-platform");
      studioServices(backendDb, config).videos.replaceTargets(adminId, session.draftId, session.selected);
      if (session.selected.includes("youtube_shorts")) {
        const next = { ...session, step: "youtube_title" };
        saveSession(backendDb, adminId, next);
        await replyVideoPrompt(ctx, t(locale, "video.prompt-yt-title"));
      } else await askInstagramOrSchedule(ctx, backendDb, adminId, session);
    } else if (data === "video_game_skip") {
      const session = getSession(backendDb, adminId);
      if (!session?.draftId || session.step !== "youtube_game_url") throw new StudioError("err.video-reopen-create");
      setData(backendDb, adminId, session, "youtube_game_url", "", "youtube_tags");
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t(locale, "video.game-skipped"));
      await replyVideoPrompt(ctx, t(locale, "video.prompt-yt-tags"));
      return true;
    } else if (data.startsWith("video_open:")) {
      const id = Number(data.slice("video_open:".length));
      studioServices(backendDb, config).videos.get(adminId, id);
      const preview = videoPreview(backendDb, id, botLocale(backendDb, adminId));
      const messageId = callbackMessageId(ctx);
      if (messageId && ctx.chat?.id) setTelegramVideoCard(backendDb, id, Number(ctx.chat.id), messageId);
      await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
    } else if (data.startsWith("video_retry:")) {
      const [, target, idText] = data.split(":");
      const targetName = target as VideoTarget;
      const id = Number(idText);
      if (!VIDEO_TARGETS.includes(targetName)) throw new StudioError("err.unknown-platform");
      studioServices(backendDb, config).videos.retry(adminId, id, targetName);
      const preview = videoPreview(backendDb, id, botLocale(backendDb, adminId));
      await ctx.answerCallbackQuery({ text: t(locale, "video.requeued", { label: videoTargetLabel(targetName) }) });
      await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
      return true;
    } else if (data.startsWith("video_schedule_confirm:")) {
      const id = Number(data.slice("video_schedule_confirm:".length));
      const session = getSession(backendDb, adminId);
      if (!session || session.draftId !== id || session.step !== "schedule_confirm") throw new StudioError("action.schedule-expired");
      const values = session.data.schedule as Record<string, string> | undefined;
      if (!values) throw new StudioError("action.schedule-expired");
      await finishVideoSchedule(
        ctx,
        backendDb,
        config,
        adminId,
        session,
        Object.fromEntries(Object.entries(values).map(([target, value]) => [target, new Date(value)])) as Partial<
          Record<VideoTarget, Date>
        >,
      );
    } else if (await handleScheduleCallback(ctx, backendDb, config, adminId, data)) {
      // handled above
    } else if (data.startsWith("video_now:")) {
      const id = Number(data.slice("video_now:".length));
      studioServices(backendDb, config).videos.get(adminId, id);
      const preview = videoPreview(backendDb, id, botLocale(backendDb, adminId));
      await ctx.editMessageText(`${preview.text}\n\n${t(locale, "video.publish-now-q")}`, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text(t(locale, "video.publish-now-yes"), `video_now_confirm:${id}`)
          .text(t(locale, "common.back"), `video_open:${id}`),
      });
    } else if (data.startsWith("video_now_confirm:")) {
      const id = Number(data.slice("video_now_confirm:".length));
      await finishVideoNow(ctx, backendDb, config, adminId, {
        draftId: id,
        step: "",
        selected: [],
        data: { controlMessageId: callbackMessageId(ctx) },
      });
    } else if (data.startsWith("video_cancel_ask:")) {
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
      return true;
    } else if (data.startsWith("video_remove_ask:")) {
      const [, targetText, idText] = data.split(":");
      const target = targetText as VideoTarget;
      const id = Number(idText);
      if (!VIDEO_TARGETS.includes(target)) throw new StudioError("err.unknown-platform");
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
      return true;
    } else if (data.startsWith("video_cancel:")) {
      const cancellation = await studioServices(backendDb, config).videos.cancel(adminId, Number(data.slice("video_cancel:".length)));
      clearSession(backendDb, adminId);
      const manualRemoval = cancellation.manualRemoval
        .map(({ target, url }) => t(locale, "video.remove-manually", { label: videoTargetLabel(target), url: url ? `: ${url}` : "" }))
        .join("\n");
      const heldPrivate = cancellation.heldPrivateYouTubeIds.length ? `\n${t(locale, "video.held-private")}` : "";
      const attention = cancellation.holdFailures.length ? `\n${t(locale, "video.hold-failed")}` : "";
      await ctx.editMessageText(
        `${t(locale, "video.cancelled-local", { hours: config.VIDEO_MEDIA_RETENTION_HOURS })}${heldPrivate}${attention}${manualRemoval ? `\n\n${t(locale, "video.already-published")}\n${manualRemoval}` : ""}`,
      );
    } else if (data.startsWith("video_time:")) {
      const [, targetText, idText] = data.split(":");
      const target = targetText as VideoTarget;
      const id = Number(idText);
      studioServices(backendDb, config).videos.get(adminId, id);
      const session = {
        draftId: id,
        step: `schedule_target:${target}`,
        selected: [target],
        data: { controlMessageId: callbackMessageId(ctx) },
      };
      saveSession(backendDb, adminId, session);
      setControlFromSession(backendDb, config, adminId, id, ctx, session);
      await replyVideoPrompt(ctx, t(locale, "video.schedule-target-prompt", { target: videoTargetLabel(target) }));
    } else if (data.startsWith("video_remove:")) {
      const [, targetText, idText] = data.split(":");
      const target = targetText as VideoTarget;
      const id = Number(idText);
      const { cancelled } = studioServices(backendDb, config).videos.removeTarget(adminId, id, target);
      if (cancelled) {
        clearSession(backendDb, adminId);
        await ctx.editMessageText(t(locale, "video.all-removed"));
      } else {
        await ctx.answerCallbackQuery({ text: t(locale, "video.removed", { label: videoTargetLabel(target) }) });
        const preview = videoPreview(backendDb, id, botLocale(backendDb, adminId));
        await ctx.editMessageText(preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
      }
      return true;
    } else if (await handleEditMenuCallback(ctx, backendDb, config, adminId, data)) return true;
    else if (data.startsWith("video_edit:")) {
      const id = Number(data.slice("video_edit:".length));
      const details = studioServices(backendDb, config).videos.get(adminId, id);
      const session = {
        draftId: id,
        step: "label",
        selected: details.targets.map((row) => row.target as VideoTarget),
        data: { controlMessageId: callbackMessageId(ctx) },
      };
      saveSession(backendDb, adminId, session);
      setControlFromSession(backendDb, config, adminId, id, ctx, session);
      await replyVideoPrompt(ctx, t(locale, "video.edit-label-prompt"));
    }
    await ctx.answerCallbackQuery();
  } catch (error) {
    await ctx.answerCallbackQuery({ text: describeError(botLocale(backendDb, adminId), error) });
  }
  return true;
}

async function handleScheduleCallback(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  data: string,
): Promise<boolean> {
  const locale = botLocale(backendDb, adminId);
  if (data.startsWith("video_schedule:")) {
    const id = Number(data.slice("video_schedule:".length));
    const targets = studioServices(backendDb, config)
      .videos.get(adminId, id)
      .targets.map((row) => row.target as VideoTarget);
    if (!targets.length) throw new StudioError("err.video-no-platforms");
    const keyboard = new InlineKeyboard().text(t(locale, "video.same-time"), `video_common:${id}`);
    if (targets.length > 1) keyboard.row().text(t(locale, "video.different-time"), `video_individual:${id}`);
    const session = { draftId: id, step: "schedule_choice", selected: targets, data: { controlMessageId: callbackMessageId(ctx) } };
    saveSession(backendDb, adminId, session);
    setControlFromSession(backendDb, config, adminId, id, ctx, session);
    await updateVideoControl(ctx, session, t(locale, "video.schedule-time-msk"), keyboard, locale);
    return true;
  }
  if (!data.startsWith("video_common:") && !data.startsWith("video_individual:")) return false;
  const id = Number(data.split(":")[1]);
  const session = getSession(backendDb, adminId);
  const targets = studioServices(backendDb, config)
    .videos.get(adminId, id)
    .targets.map((row) => row.target as VideoTarget);
  if (!session || !targets.length) throw new StudioError("err.video-reopen-publish");
  if (data.startsWith("video_common:")) {
    saveSession(backendDb, adminId, { ...session, draftId: id, selected: targets, step: "schedule_common" });
    await replyVideoPrompt(ctx, t(locale, "video.enter-datetime"));
    return true;
  }
  const first = targets[0];
  if (!first) throw new StudioError("err.video-no-platforms");
  saveSession(backendDb, adminId, {
    ...session,
    draftId: id,
    selected: targets,
    step: `schedule_target:${first}`,
    data: { ...session.data, schedule: {} },
  });
  await replyVideoPrompt(ctx, t(locale, "video.schedule-target-prompt", { target: videoTargetLabel(first) }));
  return true;
}

async function handleEditMenuCallback(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  adminId: number,
  data: string,
): Promise<boolean> {
  const locale = botLocale(backendDb, adminId);
  if (data.startsWith("video_edit_menu:")) {
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
    return true;
  }
  if (!data.startsWith("video_edit_field:")) return false;
  const [, field = "", idText] = data.split(":");
  const id = Number(idText);
  const targets = studioServices(backendDb, config).videos.get(adminId, id).targets;
  const session = {
    draftId: id,
    step: field,
    selected: targets.map((target) => target.target as VideoTarget),
    data: { controlMessageId: callbackMessageId(ctx), is_single_edit: true },
  };
  saveSession(backendDb, adminId, session);
  setControlFromSession(backendDb, config, adminId, id, ctx, session);
  const prompts: Record<string, MessageKey> = {
    label: "video.edit-label-prompt",
    youtube_title: "video.edit-yt-title-prompt",
    youtube_description: "video.edit-yt-desc-prompt",
    youtube_game_url: "video.edit-game-url-prompt",
    youtube_tags: "video.edit-yt-tags-prompt",
    instagram_caption: "video.edit-ig-caption-prompt",
  };
  await replyVideoPrompt(ctx, t(locale, prompts[field] ?? "video.edit-generic-prompt"));
  return true;
}
