import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { getPostAdminState } from "../src/bot/post-state.js";
import { getSession } from "../src/bot/video-session.js";
import type { BackendDb } from "../src/db/client.js";
import { adminState, videoBotSessions } from "../src/db/schema.js";
import { unsafeDb } from "../src/db/unsafe.js";
import { openBackendDb } from "./helpers/open-db.js";

describe("Telegram dialog state", () => {
  it("expires a stale post state instead of applying an old text reply", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const expired = new Date(Date.now() - 31 * 60_000).toISOString();
      unsafeDb(backendDb)
        .db.insert(adminState)
        .values({ actorId: 42, action: "edit_ru", draftId: 7, controlMessageId: 9, updatedAt: expired, expiresAt: expired })
        .run();

      expect(getPostAdminState(backendDb, 42)).toBeNull();
      expect(unsafeDb(backendDb).db.select().from(adminState).where(eq(adminState.actorId, 42)).get()).toBeUndefined();
    } finally {
      backendDb.close();
    }
  });

  it("expires a stale video session instead of reopening its old wizard", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const expired = new Date(Date.now() - 31 * 60_000).toISOString();
      unsafeDb(backendDb)
        .db.insert(videoBotSessions)
        .values({
          actorId: 42,
          videoDraftId: 7,
          step: "schedule_confirm",
          selectedTargetsJson: ["youtube_shorts"],
          dataJson: {},
          updatedAt: expired,
          expiresAt: expired,
        })
        .run();

      expect(getSession(backendDb, 42)).toBeNull();
      expect(unsafeDb(backendDb).db.select().from(videoBotSessions).where(eq(videoBotSessions.actorId, 42)).get()).toBeUndefined();
    } finally {
      backendDb.close();
    }
  });

  it("drops malformed persisted state instead of dispatching an unknown step", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      unsafeDb(backendDb)
        .db.insert(videoBotSessions)
        .values({
          actorId: 42,
          videoDraftId: 7,
          step: "not-a-real-step",
          selectedTargetsJson: ["youtube_shorts"],
          dataJson: {},
          updatedAt: new Date().toISOString(),
        })
        .run();

      expect(getSession(backendDb, 42)).toBeNull();
      expect(unsafeDb(backendDb).db.select().from(videoBotSessions).where(eq(videoBotSessions.actorId, 42)).get()).toBeUndefined();
    } finally {
      backendDb.close();
    }
  });
});
