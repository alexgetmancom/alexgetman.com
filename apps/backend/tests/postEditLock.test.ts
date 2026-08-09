import { describe, expect, it } from "bun:test";
import { draftPreview } from "../src/bot/preview.js";
import { drafts } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { requirePostEditAllowed } from "../src/studio/services/post-access.js";
import { withDb } from "./helpers/db.js";

describe("locale-aware post edit lock", () => {
  it("locks only the locale that is due soon", () =>
    withDb((backendDb) => {
      const now = new Date();
      const ruAt = new Date(now.getTime() + 60_000).toISOString();
      const enAt = new Date(now.getTime() + 10 * 60_000).toISOString();
      backendDb.db
        .insert(drafts)
        .values({
          id: 8,
          actorId: 42,
          status: "scheduled",
          textRu: "RU text",
          textEnMachine: "EN text",
          textEnApproved: "EN text",
          targetsJson: JSON.stringify({ telegram_ru: true, telegram_en: true }),
          scheduledAt: ruAt,
          scheduledEnAt: enAt,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .run();
      const config = loadConfig({ CONTROLLER_ADMIN_IDS: "42", POST_EDIT_LOCK_MINUTES: "2" });

      expect(() => requirePostEditAllowed(backendDb, config, 42, 8, now, "ru")).toThrow("err.post-too-close-to-publish");
      expect(requirePostEditAllowed(backendDb, config, 42, 8, now, "en").id).toBe(8);
      expect(() => requirePostEditAllowed(backendDb, config, 42, 8, now)).toThrow("err.post-too-close-to-publish");

      const preview = JSON.stringify(draftPreview(backendDb, 8, config));
      expect(preview).toContain(`edit_menu:8`);
      expect(preview).not.toContain(`edit_ru:8`);
    }));
});
