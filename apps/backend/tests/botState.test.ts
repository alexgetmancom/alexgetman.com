import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { encodePostWizardStep, parsePostWizardStep } from "../src/bot/post-fsm.js";
import { clearPostAdminStateIfCurrent, getPostAdminState, setPostAdminState } from "../src/bot/post-state.js";
import { clearSession, getSession, saveSession } from "../src/bot/video-session.js";
import type { BackendDb } from "../src/db/client.js";
import { conversationSessions } from "../src/db/schema.js";
import { unsafeDb } from "../src/db/unsafe.js";
import { openBackendDb } from "./helpers/open-db.js";

describe("Telegram dialog state", () => {
  it("round-trips typed post wizard steps through the legacy callback values", () => {
    const value = new Date("2026-08-04T12:34:56.000Z");
    const steps = [
      { type: "new_post" } as const,
      { type: "edit_sources" } as const,
      { type: "edit_text", locale: "ru" } as const,
      { type: "replace_media", locale: "en" } as const,
      { type: "schedule_manual", locale: "ru" } as const,
      { type: "schedule_confirm", locale: "en", value } as const,
    ];

    for (const step of steps) {
      const encoded = encodePostWizardStep(step);
      expect(parsePostWizardStep(encoded)).toEqual(step);
    }
    expect(parsePostWizardStep("schedule_confirm_ru_not-a-date")).toBeNull();
  });

  it("stores new post state in the typed step column and reads legacy action rows", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      setPostAdminState(backendDb, 42, "edit_ru", 7, 9);
      expect(unsafeDb(backendDb).db.select().from(conversationSessions).where(eq(conversationSessions.actorId, 42)).get()).toMatchObject({
        action: null,
        step: "edit_ru",
      });
      expect(getPostAdminState(backendDb, 42)).toMatchObject({ action: "edit_ru", step: { type: "edit_text", locale: "ru" } });

      unsafeDb(backendDb)
        .db.update(conversationSessions)
        .set({ action: "edit_en", step: null })
        .where(eq(conversationSessions.actorId, 42))
        .run();
      expect(getPostAdminState(backendDb, 42)).toMatchObject({ action: "edit_en", step: { type: "edit_text", locale: "en" } });
    } finally {
      backendDb.close();
    }
  });

  it("increments post revisions and refuses to clear a newer dialog", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const first = setPostAdminState(backendDb, 42, "edit_ru", 7, 9);
      const second = setPostAdminState(backendDb, 42, "edit_en", 7, 10);

      expect(second).toBe(first + 1);
      expect(clearPostAdminStateIfCurrent(backendDb, 42, "edit_en", 7, first)).toBe(false);
      expect(clearPostAdminStateIfCurrent(backendDb, 42, "edit_en", 7, second)).toBe(true);
      expect(getPostAdminState(backendDb, 42)).toMatchObject({ action: null, revision: second + 1 });
    } finally {
      backendDb.close();
    }
  });

  it("increments video revisions and rejects writes from an older wizard", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const first = saveSession(backendDb, 42, { draftId: null, step: "locale", selected: [], data: {} });
      const second = saveSession(backendDb, 42, { ...first, step: "asset" });

      expect(second.revision).toBe(first.revision + 1);
      expect(() => saveSession(backendDb, 42, first)).toThrow("action.session-stale");
      expect(getSession(backendDb, 42)).toMatchObject({ step: "asset", revision: second.revision });
    } finally {
      backendDb.close();
    }
  });

  it("does not reuse a video revision after a session is cleared", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const first = saveSession(backendDb, 42, { draftId: null, step: "locale", selected: [], data: {} });
      clearSession(backendDb, 42);
      const second = saveSession(backendDb, 42, { draftId: null, step: "locale", selected: [], data: {} });

      expect(second.revision).toBeGreaterThan(first.revision);
      expect(getSession(backendDb, 42)).toMatchObject({ revision: second.revision, step: "locale" });
    } finally {
      backendDb.close();
    }
  });

  it("expires a stale post state instead of applying an old text reply", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const expired = new Date(Date.now() - 31 * 60_000).toISOString();
      unsafeDb(backendDb)
        .db.insert(conversationSessions)
        .values({
          actorId: 42,
          kind: "post",
          action: "edit_ru",
          draftId: 7,
          controlMessageId: 9,
          updatedAt: expired,
          expiresAt: expired,
        })
        .run();

      expect(getPostAdminState(backendDb, 42)).toBeNull();
      expect(unsafeDb(backendDb).db.select().from(conversationSessions).where(eq(conversationSessions.actorId, 42)).get()).toMatchObject({
        action: null,
        revision: 1,
      });
    } finally {
      backendDb.close();
    }
  });

  it("expires a stale video session instead of reopening its old wizard", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const expired = new Date(Date.now() - 31 * 60_000).toISOString();
      unsafeDb(backendDb)
        .db.insert(conversationSessions)
        .values({
          actorId: 42,
          kind: "video",
          draftId: 7,
          step: "schedule_confirm",
          selectedTargetsJson: ["youtube_shorts"],
          dataJson: {},
          updatedAt: expired,
          expiresAt: expired,
        })
        .run();

      expect(getSession(backendDb, 42)).toBeNull();
      expect(
        unsafeDb(backendDb)
          .db.select()
          .from(conversationSessions)
          .where(and(eq(conversationSessions.actorId, 42), eq(conversationSessions.kind, "video")))
          .get(),
      ).toMatchObject({
        active: 0,
      });
    } finally {
      backendDb.close();
    }
  });

  it("drops malformed persisted state instead of dispatching an unknown step", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      unsafeDb(backendDb)
        .db.insert(conversationSessions)
        .values({
          actorId: 42,
          kind: "video",
          draftId: 7,
          step: "not-a-real-step",
          selectedTargetsJson: ["youtube_shorts"],
          dataJson: {},
          updatedAt: new Date().toISOString(),
        })
        .run();

      expect(getSession(backendDb, 42)).toBeNull();
      expect(
        unsafeDb(backendDb)
          .db.select()
          .from(conversationSessions)
          .where(and(eq(conversationSessions.actorId, 42), eq(conversationSessions.kind, "video")))
          .get(),
      ).toMatchObject({
        active: 0,
      });
    } finally {
      backendDb.close();
    }
  });
});
