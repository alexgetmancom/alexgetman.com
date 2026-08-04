import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { setPostAdminState } from "../src/bot/post-state.js";
import { handleActivePublicationMessage } from "../src/bot/publication-actions.js";
import { saveSession } from "../src/bot/video-session.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { pendingAlbums } from "../src/db/schema.js";
import { unsafeDb } from "../src/db/unsafe.js";
import { loadConfig } from "../src/foundation/config.js";
import { openBackendDb } from "./helpers/open-db.js";

describe("Telegram publication message routing", () => {
  it("does not send a text message from an active video session to the post handler", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      saveSession(backendDb, 42, { draftId: null, step: "locale", selected: [], data: {} });
      const ctx = {
        from: { id: 42 },
        message: { text: "This must stay in the video flow" },
      } as unknown as Context;

      expect(await handleActivePublicationMessage(ctx, backendDb, loadConfig({ ADMIN_IDS: "42" }))).toBe(true);
      expect(unsafeDb(backendDb).sqlite.prepare("SELECT count(*) AS count FROM drafts").get()).toEqual({ count: 0 });
    } finally {
      backendDb.close();
    }
  });

  it("sends an album through the active post flow before parsing its input step", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Before", textEn: "Before", entities: [], media: [] });
      setPostAdminState(backendDb, 42, "replace_en_media", draftId, 99);
      const ctx = {
        from: { id: 42 },
        chat: { id: 100 },
        message: {
          media_group_id: "album-1",
          caption: "",
          caption_entities: [],
          photo: [{ file_id: "photo-1", width: 100, height: 100 }],
        },
        reply: async () => undefined,
      } as unknown as Context;

      expect(await handleActivePublicationMessage(ctx, backendDb, loadConfig({ ADMIN_IDS: "42" }))).toBe(true);
      expect(unsafeDb(backendDb).db.select().from(pendingAlbums).all()).toHaveLength(1);
    } finally {
      backendDb.close();
    }
  });
});
