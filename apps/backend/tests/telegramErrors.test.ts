import { describe, expect, it } from "bun:test";
import { isUnchangedMessageEdit } from "../src/bot/telegram-errors.js";

describe("isUnchangedMessageEdit", () => {
  it("recognises the no-op edit Telegram rejects", () => {
    const error = new Error(
      "Call to 'editMessageText' failed! (400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same)",
    );
    expect(isUnchangedMessageEdit(error)).toBe(true);
  });

  // These are the cases the empty catch used to swallow along with the benign
  // one: a card that stops updating for any of them should reach the logs.
  it("does not swallow real edit failures", () => {
    expect(isUnchangedMessageEdit(new Error("400: Bad Request: can't parse entities"))).toBe(false);
    expect(isUnchangedMessageEdit(new Error("403: Forbidden: bot was blocked by the user"))).toBe(false);
    expect(isUnchangedMessageEdit(new Error("400: Bad Request: message to edit not found"))).toBe(false);
  });

  it("tolerates non-Error rejections", () => {
    expect(isUnchangedMessageEdit("message is not modified")).toBe(true);
    expect(isUnchangedMessageEdit(undefined)).toBe(false);
    expect(isUnchangedMessageEdit(null)).toBe(false);
  });
});
