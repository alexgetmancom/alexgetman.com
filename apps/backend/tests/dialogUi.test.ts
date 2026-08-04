import { describe, expect, it } from "bun:test";
import { InlineKeyboard } from "grammy";
import { appendCancelButton, appendResultNavigation, cancelPromptKeyboard, confirmationKeyboard } from "../src/bot/dialog-ui.js";
import { t } from "../src/foundation/i18n/index.js";

describe("Telegram dialog UI", () => {
  it("keeps prompt and confirmation callbacks versioned in one place", () => {
    expect(cancelPromptKeyboard("en", "cancel_state:7:overview", 4).inline_keyboard).toEqual([
      [{ text: "← Cancel", callback_data: "sv4|cancel_state:7:overview" }],
    ]);
    expect(
      confirmationKeyboard({ label: "Yes", callback: "confirm:7" }, { label: "Back", callback: "preview:7" }, 5).inline_keyboard,
    ).toEqual([
      [
        { text: "Yes", callback_data: "sv5|confirm:7" },
        { text: "Back", callback_data: "sv5|preview:7" },
      ],
    ]);
  });

  it("appends shared cancel and result navigation without disturbing existing rows", () => {
    const keyboard = new InlineKeyboard().text("Action", "action").row();
    appendCancelButton(keyboard, "en", "cancel", 2);
    appendResultNavigation(keyboard, "en", "drafts");

    expect(keyboard.inline_keyboard).toEqual([
      [{ text: "Action", callback_data: "action" }],
      [
        { text: "← Cancel", callback_data: "sv2|cancel" },
        { text: t("en", "action.back-to-drafts"), callback_data: "queue_drafts" },
        { text: t("en", "common.menu"), callback_data: "menu_home" },
      ],
    ]);
  });
});
