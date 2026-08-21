import { describe, expect, it } from "bun:test";
import { draftPreview } from "../src/bot/preview.js";
import { requirePostEditAllowed } from "../src/studio/services/post-access.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("locale-aware post edit lock", () => {
  it("locks only the locale that is due soon", () =>
    withDb((backendDb) => {
      const now = new Date();
      const ruAt = new Date(now.getTime() + 60_000).toISOString();
      const enAt = new Date(now.getTime() + 10 * 60_000).toISOString();
      seedTextPost(backendDb, {
        draftId: 8,
        actorId: 42,
        status: "scheduled",
        ru: "RU text",
        en: "EN text",
        targets: { telegram_ru: true, telegram_en: true },
        scheduledAt: ruAt,
        scheduledEnAt: enAt,
        now: now.toISOString(),
      });
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", POST_EDIT_LOCK_MINUTES: "2" });

      expect(() => requirePostEditAllowed(backendDb, config, 42, 8, now, "ru")).toThrow("err.post-too-close-to-publish");
      expect(requirePostEditAllowed(backendDb, config, 42, 8, now, "en").id).toBe(8);
      expect(() => requirePostEditAllowed(backendDb, config, 42, 8, now)).toThrow("err.post-too-close-to-publish");

      const preview = JSON.stringify(draftPreview(backendDb, 8, config, "en"));
      expect(preview).toContain(`edit_menu:8`);
      expect(preview).not.toContain(`edit_ru:8`);
    }));
});
