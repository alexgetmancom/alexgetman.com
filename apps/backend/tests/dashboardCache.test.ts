import { describe, expect, it } from "bun:test";
import { registerChannel } from "../src/channels/registry.js";
import { publishJobs } from "../src/db/schema.js";
import { renderDashboard } from "../src/interfaces/web/dashboard.js";
import { commandCenterFingerprint } from "../src/operations/command-center.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("dashboard render cache", () => {
  it("reuses an identical dashboard until its database revision changes", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadTestConfig({ COMMAND_CENTER_TOKEN: "secret" });
      const first = renderDashboard(config, backendDb, 0, "", undefined, undefined, "queue");
      expect(renderDashboard(config, backendDb, 0, "", undefined, undefined, "queue")).toBe(first);
      const now = new Date().toISOString();
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationKey: "post:cache",
          target: "telegram",
          status: "failed",
          payloadJson: {},
          createdAt: now,
          updatedAt: now,
        })
        .run();

      expect(renderDashboard(config, backendDb, 0, "", undefined, undefined, "queue")).not.toBe(first);
    } finally {
      backendDb.close();
    }
  });

  it("keeps publications from the current local day in the combined history", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      registerChannel(backendDb, { platform: "site", locale: "ru", provider: "native", targetId: "site_ru", source: "test" });
      const now = new Date().toISOString();
      seedTextPost(backendDb, { postId: 1, ru: "Current local day", slugRu: "today", siteRu: true, now });

      expect(
        renderDashboard(
          loadTestConfig({ COMMAND_CENTER_TOKEN: "secret", CONTROLLER_BOT_TOKEN: "bot", CONTROLLER_ADMIN_IDS: "42" }),
          backendDb,
          0,
        ),
      ).toContain("Current local day");
    } finally {
      backendDb.close();
    }
  });

  it("replaces first-run guidance after a channel is connected outside the dashboard", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadTestConfig({ COMMAND_CENTER_TOKEN: "secret", CONTROLLER_BOT_TOKEN: "bot", CONTROLLER_ADMIN_IDS: "42" });
      expect(renderDashboard(config, backendDb, 0)).toContain("Опубликуйте первый черновик");

      registerChannel(backendDb, { platform: "telegram", locale: "ru", provider: "native", targetId: "telegram", source: "test" });

      expect(renderDashboard(config, backendDb, 0)).not.toContain("Опубликуйте первый черновик");
    } finally {
      backendDb.close();
    }
  });

  it("does not invalidate rendered data when only the metric scheduler advances", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const before = commandCenterFingerprint(backendDb);
      backendDb.sqlite
        .prepare("INSERT INTO metric_schedule(publication_key,target,next_check_at,updated_at) VALUES ('post:cache','telegram',?,?)")
        .run("2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
      expect(commandCenterFingerprint(backendDb)).toEqual(before);
      backendDb.sqlite
        .prepare("UPDATE metric_schedule SET last_error = 'provider failed', updated_at = ? WHERE publication_key = 'post:cache'")
        .run("2026-08-10T00:01:00.000Z");
      expect(commandCenterFingerprint(backendDb)).not.toEqual(before);
    } finally {
      backendDb.close();
    }
  });
});
