import type { Bot } from "grammy";
import type { Hono } from "hono";
import type { BackendConfig } from "../../foundation/config.js";
import { safeEqual } from "../../foundation/http-auth.js";
import { text } from "../../foundation/http-response.js";

/** grammy's `bot.init()` fetches the bot identity and must finish before the
 * first update is handled. Under webhooks there is no long-polling start to do
 * it, and concurrent updates would each begin their own — so the first caller's
 * promise is cached and awaited by the rest. */
const botInitialization = new WeakMap<Bot, Promise<void>>();

function initializeWebhookBot(bot: Bot): Promise<void> {
  const existing = botInitialization.get(bot);
  if (existing) return existing;
  const initialization = bot.init();
  botInitialization.set(bot, initialization);
  return initialization;
}

/** Lives under interfaces/telegram/ rather than with the other route modules
 * because it is the one HTTP surface that speaks grammy — the layer check in
 * .dependency-cruiser.jsonc keeps that SDK confined here. */
export function telegramWebhookRoute(app: Hono, config: BackendConfig, bot: Bot | null): void {
  app.post(config.WEBHOOK_PATH, async (c) => {
    const request = c.req.raw;
    if (!safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", config.TELEGRAM_WEBHOOK_SECRET ?? ""))
      return text("forbidden\n", 403);
    const update = await request.json().catch(() => null);
    if (bot && update) {
      await initializeWebhookBot(bot);
      await bot.handleUpdate(update as Parameters<Bot["handleUpdate"]>[0]);
    }
    return text("ok\n");
  });
}
