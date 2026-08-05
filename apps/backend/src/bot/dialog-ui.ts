import { InlineKeyboard } from "grammy";
import { t } from "../foundation/i18n/index.js";
import type { BotLocale } from "./i18n.js";
import { versionedCallback } from "./publication-callback.js";

export type DialogButton = { label: string; callback: string };

/** Renders a compact row of dialog actions with an optional session revision. */
function dialogKeyboard(buttons: readonly DialogButton[], revision?: number | null): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const button of buttons) keyboard.text(button.label, versionedCallback(button.callback, revision));
  return keyboard;
}

/** Adds the standard cancel action to a prompt keyboard. */
export function appendCancelButton(
  keyboard: InlineKeyboard,
  locale: BotLocale,
  callback: string,
  revision?: number | null,
): InlineKeyboard {
  keyboard.text(t(locale, "common.cancel"), versionedCallback(callback, revision));
  return keyboard;
}

/** Builds a free-text prompt keyboard with only its cancel action. */
export function cancelPromptKeyboard(locale: BotLocale, callback: string, revision?: number | null): InlineKeyboard {
  return appendCancelButton(new InlineKeyboard(), locale, callback, revision);
}

/** Builds the repeated two-button confirmation footer used by content flows. */
export function confirmationKeyboard(confirm: DialogButton, back: DialogButton, revision?: number | null): InlineKeyboard {
  return dialogKeyboard([confirm, back], revision);
}

/** Builds the final navigation footer after a draft operation. */
export function resultNavigationKeyboard(locale: BotLocale, primary: "drafts" | "upcoming"): InlineKeyboard {
  return appendResultNavigation(new InlineKeyboard(), locale, primary);
}

/** Appends a result footer to a keyboard that already contains operation
 * specific actions, preserving the existing rows. */
export function appendResultNavigation(keyboard: InlineKeyboard, locale: BotLocale, primary: "drafts" | "upcoming"): InlineKeyboard {
  const primaryAction =
    primary === "drafts"
      ? { label: t(locale, "action.back-to-drafts"), callback: "queue_drafts" }
      : { label: t(locale, "queue.upcoming-btn"), callback: "queue_home" };
  keyboard.text(primaryAction.label, primaryAction.callback).text(t(locale, "common.menu"), "menu_home");
  return keyboard;
}
