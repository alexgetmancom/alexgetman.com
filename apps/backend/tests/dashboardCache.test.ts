import { describe, expect, it } from "bun:test";
import { openBackendDb } from "../src/db/client.js";
import { publishJobs } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { invalidateDashboardRenderCache, renderDashboard } from "../src/interfaces/web/dashboard.js";

describe("dashboard render cache", () => {
  it("reuses an identical dashboard briefly and invalidates after a mutation", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ COMMAND_CENTER_TOKEN: "secret" });
      const first = renderDashboard(config, backendDb, 0, "", "", undefined, undefined, "queue");
      const now = new Date().toISOString();
      backendDb.db
        .insert(publishJobs)
        .values({
          postKey: "post:cache",
          messageId: 1,
          target: "telegram",
          status: "failed",
          payloadJson: {},
          createdAt: now,
          updatedAt: now,
        })
        .run();

      expect(renderDashboard(config, backendDb, 0, "", "", undefined, undefined, "queue")).toBe(first);
      invalidateDashboardRenderCache(backendDb);
      expect(renderDashboard(config, backendDb, 0, "", "", undefined, undefined, "queue")).not.toBe(first);
    } finally {
      backendDb.close();
    }
  });
});
