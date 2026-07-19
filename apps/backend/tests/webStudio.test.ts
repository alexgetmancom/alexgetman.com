import { describe, expect, it } from "bun:test";
import { createApiHandler } from "../src/api.js";
import { openBackendDb } from "../src/db/client.js";
import { recordDomainEvent } from "../src/domain/events.js";
import { loadConfig } from "../src/foundation/config.js";

const COMMAND_TOKEN = "b".repeat(16);

function testConfig() {
  return loadConfig({ ADMIN_IDS: "42", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "42", COMMAND_CENTER_TOKEN: COMMAND_TOKEN });
}

describe("Command Center Studio tab", () => {
  it("gates the studio tab behind the Command Center token and renders the shared read model", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = testConfig();
      const app = createApiHandler({ config, backendDb, bot: null });

      const anonymous = await app(new Request("http://localhost/command-center?tab=studio"));
      expect(anonymous.status).toBe(200);
      expect(await anonymous.text()).toContain("Command Center token");

      recordDomainEvent(backendDb, {
        ref: null,
        type: "studio.notification.test",
        severity: "info",
        target: "mcp",
        message: "Hello inbox",
      });

      const authorized = await app(
        new Request("http://localhost/command-center?tab=studio", { headers: { "X-Admin-Token": COMMAND_TOKEN } }),
      );
      expect(authorized.status).toBe(200);
      const dashboardText = await authorized.text();
      expect(dashboardText).toContain("Hello inbox");
      expect(dashboardText).toContain("Очередь");
      expect(dashboardText).toContain("Уведомления");
      expect(dashboardText).toContain('href="/command-center?tab=studio"');

      const event = backendDb.sqlite.prepare("SELECT id FROM post_events WHERE message = ?").get("Hello inbox") as { id: number };
      const origin = new URL(config.COMMAND_CENTER_URL).origin;
      const acknowledge = await app(
        new Request("http://localhost/command-center/studio/acknowledge", {
          method: "POST",
          headers: { "X-Admin-Token": COMMAND_TOKEN, origin, "content-type": "application/x-www-form-urlencoded" },
          body: `id=${event.id}`,
        }),
      );
      expect(acknowledge.status).toBe(303);
      expect(acknowledge.headers.get("location")).toBe("/command-center?tab=studio");

      const afterAck = await app(
        new Request("http://localhost/command-center?tab=studio", { headers: { "X-Admin-Token": COMMAND_TOKEN } }),
      );
      expect(await afterAck.text()).not.toContain("Hello inbox");
    } finally {
      backendDb.close();
    }
  });

  it("refuses to acknowledge notifications without a same-origin Command Center session", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = testConfig();
      const app = createApiHandler({ config, backendDb, bot: null });
      const denied = await app(
        new Request("http://localhost/command-center/studio/acknowledge", {
          method: "POST",
          headers: { "X-Admin-Token": COMMAND_TOKEN, "content-type": "application/x-www-form-urlencoded" },
          body: "id=1",
        }),
      );
      expect(denied.status).toBe(403);
    } finally {
      backendDb.close();
    }
  });

  it("hides the studio tab when no Studio actor is configured", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ COMMAND_CENTER_TOKEN: COMMAND_TOKEN });
      const app = createApiHandler({ config, backendDb, bot: null });
      const response = await app(
        new Request("http://localhost/command-center?tab=studio", { headers: { "X-Admin-Token": COMMAND_TOKEN } }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('href="/command-center?tab=studio"');
    } finally {
      backendDb.close();
    }
  });
});
