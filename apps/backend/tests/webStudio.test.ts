import { describe, expect, it } from "bun:test";
import { createApiHandler } from "../src/api.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const COMMAND_TOKEN = "b".repeat(16);

function testConfig() {
  return loadTestConfig({
    CONTROLLER_ADMIN_IDS: "42",
    MCP_STUDIO_TOKEN: "a".repeat(16),
    MCP_STUDIO_ACTOR_ID: "42",
    COMMAND_CENTER_TOKEN: COMMAND_TOKEN,
    PUBLIC_BASE_URL: "https://publisher.example.com",
    TOKEN_ENCRYPTION_KEY: "cd".repeat(32),
    THREADS_APP_ID: "threads-id",
    THREADS_APP_SECRET: "threads-secret",
    INSTAGRAM_APP_ID: "instagram-id",
    INSTAGRAM_APP_SECRET: "instagram-secret",
  });
}

describe("Command Center Studio tab", () => {
  it("gates the studio tab behind the Command Center token and renders the shared read model", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = testConfig();
      const app = createApiHandler({ config, backendDb });

      const anonymous = await app(new Request("http://localhost/command-center?tab=studio"));
      expect(anonymous.status).toBe(200);
      expect(await anonymous.text()).toContain("Токен Command Center");

      const authorized = await app(
        new Request("http://localhost/command-center?tab=studio", { headers: { "X-Admin-Token": COMMAND_TOKEN } }),
      );
      expect(authorized.status).toBe(200);
      const dashboardText = await authorized.text();
      expect(dashboardText).toContain("Очередь");
      expect(dashboardText).not.toContain("Уведомления");
      expect(dashboardText).toContain('href="/command-center?tab=studio"');
      expect(dashboardText).toContain("Подключить Threads RU");
      expect(dashboardText).toContain("/oauth/threads/start?locale=ru");
      expect(dashboardText).toContain("Подключить Instagram EN");
    } finally {
      backendDb.close();
    }
  });

  it("hides the studio tab when no Studio actor is configured", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadTestConfig({ COMMAND_CENTER_TOKEN: COMMAND_TOKEN });
      const app = createApiHandler({ config, backendDb });
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
