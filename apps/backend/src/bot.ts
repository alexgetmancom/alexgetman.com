import { Bot, InlineKeyboard } from "grammy";
import { appendPendingAlbum } from "./bot/albums.js";
import { applyAdminState, getAdminState, handleDraftCallback, sendDraftPreview } from "./bot/callbacks.js";
import { createDraftFromMessage, scheduledDrafts } from "./bot/drafts.js";
import { extractMessage } from "./bot/message.js";
import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
import { log } from "./logger.js";
import { formatMsk } from "./publishingSchedule.js";
import { translateToEnglish } from "./translation.js";

export function createBot(config: BackendConfig, backendDb: BackendDb): Bot | null {
  if (!config.controllerBotToken) {
    log("warn", "Telegram bot token is not configured; bot is disabled");
    return null;
  }
  const bot = new Bot(config.controllerBotToken, { client: { apiRoot: config.TELEGRAM_API_BASE_URL } });
  bindBotHandlers(bot, config, backendDb);
  bot.catch((error) => log("error", "grammY handler failed", { error: String(error.error) }));
  return bot;
}

function bindBotHandlers(bot: Bot, config: BackendConfig, backendDb: BackendDb): void {
  bot.command("start", (ctx) => ctx.reply("Send draft text with optional photo/video. Use Publish after preview."));
  bot.command("pipeline_status", (ctx) => ctx.reply(`${config.COMMAND_CENTER_URL.replace(/\/$/, "")}/pipeline-status`));
  bot.command("schedule", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply("Forbidden"));
    const rows = scheduledDrafts(backendDb);
    if (rows.length === 0) return void (await ctx.reply("No scheduled drafts."));
    const keyboard = new InlineKeyboard();
    for (const draft of rows)
      keyboard.text(`#${draft.id} ${formatMsk(draft.scheduledAt)} / ${formatMsk(draft.scheduledEnAt)}`, `schedule:${draft.id}`).row();
    await ctx.reply("Scheduled drafts", { reply_markup: keyboard });
  });
  bot.on("message", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply("Forbidden"));
    const adminId = Number(ctx.from?.id);
    const state = getAdminState(backendDb, adminId);
    const message = extractMessage(ctx);
    const mediaGroupId = ctx.message && "media_group_id" in ctx.message ? ctx.message.media_group_id : undefined;
    if (mediaGroupId && message.media.length > 0) {
      const media = message.media[0];
      if (!media) return;
      const isNew = appendPendingAlbum(backendDb, {
        adminId,
        chatId: Number(ctx.chat?.id),
        mediaGroupId,
        text: message.text,
        entities: message.entities,
        media,
        action: state?.action ?? null,
        draftId: state?.draft_id ?? null,
      });
      if (isNew) await ctx.reply("Album received. I will create or update the draft in a few seconds.");
      return;
    }
    if (state?.action && state.draft_id) return applyAdminState(ctx, backendDb, state.action, state.draft_id);
    let textEn = message.text;
    try {
      textEn = await translateToEnglish(message.text, config);
    } catch (error) {
      log("warn", "draft translation failed", { error: String(error) });
      textEn = "";
    }
    const draftId = createDraftFromMessage(backendDb, adminId, { ...message, textEn });
    await sendDraftPreview(ctx, backendDb, draftId);
  });
  bot.on("callback_query:data", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.answerCallbackQuery({ text: "Forbidden" }));
    await handleDraftCallback(ctx, backendDb, config);
  });
}

function isAdmin(config: BackendConfig, userId: number | undefined): boolean {
  if (!userId) return false;
  return config.ADMIN_IDS.length === 0 || config.ADMIN_IDS.includes(userId);
}
