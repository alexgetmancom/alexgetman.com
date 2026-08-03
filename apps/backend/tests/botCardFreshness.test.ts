import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { isStalePostCardCallback, isStaleVideoCardCallback } from "../src/bot/card-freshness.js";
import type { BackendDb } from "../src/db/client.js";
import { setTelegramPostCard, setTelegramVideoCard } from "../src/interfaces/telegram/control-cards.js";
import { openBackendDb } from "./helpers/open-db.js";

function callbackContext(messageId: number): Context {
  return { callbackQuery: { message: { message_id: messageId } } } as unknown as Context;
}

describe("Telegram card freshness", () => {
  it("rejects a mutation from a replaced post card but allows the current one", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      setTelegramPostCard(backendDb, 7, 100, 20);
      expect(isStalePostCardCallback(callbackContext(19), backendDb, "publish", 7)).toBe(true);
      expect(isStalePostCardCallback(callbackContext(20), backendDb, "publish", 7)).toBe(false);
      expect(isStalePostCardCallback(callbackContext(19), backendDb, "preview", 7)).toBe(false);
    } finally {
      backendDb.close();
    }
  });

  it("rejects a mutation from a replaced video card", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      setTelegramVideoCard(backendDb, 7, 100, 20);
      expect(isStaleVideoCardCallback(callbackContext(19), backendDb, "video_schedule:7")).toBe(true);
      expect(isStaleVideoCardCallback(callbackContext(20), backendDb, "video_schedule:7")).toBe(false);
      expect(isStaleVideoCardCallback(callbackContext(19), backendDb, "video_open:7")).toBe(false);
    } finally {
      backendDb.close();
    }
  });
});
