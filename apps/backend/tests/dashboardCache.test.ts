import { describe, expect, it } from "bun:test";
import { postLocales, posts, publications, publishJobs } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { renderDashboard } from "../src/interfaces/web/dashboard.js";
import { openBackendDb } from "./helpers/open-db.js";

describe("dashboard render cache", () => {
  it("reuses an identical dashboard until its database revision changes", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ COMMAND_CENTER_TOKEN: "secret" });
      const first = renderDashboard(config, backendDb, 0, "", "", undefined, undefined, "queue");
      expect(renderDashboard(config, backendDb, 0, "", "", undefined, undefined, "queue")).toBe(first);
      const now = new Date().toISOString();
      backendDb.db
        .insert(publishJobs)
        .values({
          postId: 1,
          postKey: "post:cache",
          messageId: 1,
          target: "telegram",
          status: "failed",
          payloadJson: {},
          createdAt: now,
          updatedAt: now,
        })
        .run();

      expect(renderDashboard(config, backendDb, 0, "", "", undefined, undefined, "queue")).not.toBe(first);
    } finally {
      backendDb.close();
    }
  });

  it("keeps publications from the current local day in the combined history", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(publications)
        .values({ postId: 1, status: "published", telegramMessageId: 1, createdAt: now, updatedAt: now })
        .run();
      backendDb.db
        .insert(posts)
        .values({ postKey: "post:1", postId: 1, channel: "test", messageId: 1, createdAt: now, updatedAt: now })
        .run();
      backendDb.db.insert(postLocales).values({ postId: 1, locale: "ru", slug: "today", text: "Current local day", updatedAt: now }).run();

      expect(renderDashboard(loadConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb, 0)).toContain("Current local day");
    } finally {
      backendDb.close();
    }
  });
});
