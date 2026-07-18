import { describe, expect, it } from "bun:test";
import { createApiHandler } from "../src/api.js";
import { openBackendDb } from "../src/db/client.js";
import { recordDomainEvent } from "../src/domain/events.js";
import { loadConfig } from "../src/foundation/config.js";

const STUDIO_TOKEN = "a".repeat(16);

function testConfig() {
  return loadConfig({ ADMIN_IDS: "42", MCP_STUDIO_TOKEN: STUDIO_TOKEN, MCP_STUDIO_ACTOR_ID: "42", COMMAND_CENTER_TOKEN: "b".repeat(16) });
}

describe("Web Studio", () => {
  it("gates the dashboard behind the Studio token and renders the shared read model once authorized", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = testConfig();
      const app = createApiHandler({ config, backendDb, bot: null });
      const origin = new URL(config.COMMAND_CENTER_URL).origin;

      const anonymous = await app(new Request("http://localhost/studio"), "/studio");
      expect(anonymous.status).toBe(200);
      expect(await anonymous.text()).toContain("Studio token");

      const badLogin = await app(
        new Request("http://localhost/studio", {
          method: "POST",
          headers: { origin, "content-type": "application/x-www-form-urlencoded" },
          body: "token=wrong",
        }),
        "/studio",
      );
      expect(await badLogin.text()).toContain("Invalid token");

      const crossOrigin = await app(
        new Request("http://localhost/studio", {
          method: "POST",
          headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
          body: `token=${STUDIO_TOKEN}`,
        }),
        "/studio",
      );
      expect(crossOrigin.status).toBe(403);

      const tokenLogin = await app(new Request(`http://localhost/studio?token=${STUDIO_TOKEN}`), "/studio");
      expect(tokenLogin.status).toBe(303);
      const cookie = tokenLogin.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toContain("studio_token=");

      recordDomainEvent(backendDb, {
        ref: null,
        type: "studio.notification.test",
        severity: "info",
        target: "mcp",
        message: "Hello inbox",
      });

      const dashboard = await app(new Request("http://localhost/studio", { headers: { cookie: cookie ?? "" } }), "/studio");
      expect(dashboard.status).toBe(200);
      const dashboardText = await dashboard.text();
      expect(dashboardText).toContain("Hello inbox");
      expect(dashboardText).toContain("Queue");
      expect(dashboardText).toContain("Notifications");

      const event = backendDb.sqlite.prepare("SELECT id FROM post_events WHERE message = ?").get("Hello inbox") as { id: number };
      const acknowledge = await app(
        new Request("http://localhost/studio/acknowledge", {
          method: "POST",
          headers: { cookie: cookie ?? "", origin, "content-type": "application/x-www-form-urlencoded" },
          body: `id=${event.id}`,
        }),
        "/studio/acknowledge",
      );
      expect(acknowledge.status).toBe(303);
      expect(acknowledge.headers.get("location")).toBe("/studio");

      const afterAck = await app(new Request("http://localhost/studio", { headers: { cookie: cookie ?? "" } }), "/studio");
      expect(await afterAck.text()).not.toContain("Hello inbox");
    } finally {
      backendDb.close();
    }
  });

  it("refuses to acknowledge notifications without a valid Studio session", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = testConfig();
      const app = createApiHandler({ config, backendDb, bot: null });
      const denied = await app(
        new Request("http://localhost/studio/acknowledge", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "id=1",
        }),
        "/studio/acknowledge",
      );
      expect(denied.status).toBe(403);
    } finally {
      backendDb.close();
    }
  });
});
