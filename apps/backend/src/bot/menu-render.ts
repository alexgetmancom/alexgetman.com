import type { Menu } from "@grammyjs/menu";
import { type Context, Keyboard } from "grammy";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";

export const MAIN_MENU_TEXT = "\u2063";

/** Rendering the main menu, separated from building it.
 *
 * These two helpers used to live in navigation.ts next to `buildMainMenu`, which
 * put them behind that module's imports of every screen it can open — so a
 * screen needing nothing but the persistent keyboard had to import back into
 * navigation, and post-screen and settings-screen each closed an import cycle.
 * Neither helper knows how the menu is assembled: `showMainMenu` takes the built
 * menu as an argument. */

export function persistentKeyboard(locale: StudioLocale = "en"): Keyboard {
  return new Keyboard().text(t(locale, "menu.button")).resized().persistent();
}

export async function showMainMenu(ctx: Context, mainMenu: Menu<Context>, edit = false): Promise<void> {
  // Telegram does not allow a message consisting only of an inline keyboard.
  const options = { reply_markup: mainMenu };
  if (edit) await ctx.editMessageText(MAIN_MENU_TEXT, options);
  else await ctx.reply(MAIN_MENU_TEXT, options);
}
