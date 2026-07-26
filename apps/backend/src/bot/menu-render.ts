import type { Menu } from "@grammyjs/menu";
import { type Context, Keyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { t } from "../foundation/i18n/index.js";
import { type BotLocale, botLocale } from "./i18n.js";

/** Rendering the main menu, separated from building it.
 *
 * These two helpers used to live in navigation.ts next to `buildMainMenu`, which
 * put them behind that module's imports of every screen it can open — so a
 * screen needing nothing but the persistent keyboard had to import back into
 * navigation, and post-screen and settings-screen each closed an import cycle.
 * Neither helper knows how the menu is assembled: `showMainMenu` takes the built
 * menu as an argument. */

export function persistentKeyboard(locale: BotLocale = "en"): Keyboard {
  return new Keyboard().text(t(locale, "menu.button")).resized().persistent();
}

export async function showMainMenu(ctx: Context, backendDb: BackendDb, mainMenu: Menu<Context>, edit = false): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  // Telegram does not allow a message consisting only of an inline keyboard.
  // This is deliberately a neutral heading, not a noisy "all clear" status.
  const text = t(locale, "menu.control-panel");
  const options = { reply_markup: mainMenu };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}
