import { describe, expect, it } from "bun:test";
import { createApiHandler } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { openBackendDb } from "../src/db/client.js";

function request(app: ReturnType<typeof createApiHandler>, body: unknown, authorization?: string) {
  return app(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
    }),
    "/api/mcp",
  );
}

describe("Studio MCP", () => {
  it("exposes owner-bound Studio commands only to the configured bearer token and audits mutations", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ ADMIN_IDS: "42", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "42" });
      const app = createApiHandler({ config, backendDb, bot: null });
      const anonymousTools = await request(app, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(JSON.stringify(await anonymousTools.json())).not.toContain("studio_post_create");

      const authorizedTools = await request(app, { jsonrpc: "2.0", id: 2, method: "tools/list" }, `Bearer ${"a".repeat(16)}`);
      expect(JSON.stringify(await authorizedTools.json())).toContain("studio_post_create");

      const denied = await request(
        app,
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "studio_queue", arguments: {} } },
        "Bearer wrong",
      );
      expect(await denied.json()).toMatchObject({ error: { code: -32001 } });

      const created = await request(
        app,
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "studio_post_create", arguments: { text: "MCP draft" } } },
        `Bearer ${"a".repeat(16)}`,
      );
      expect(await created.json()).toMatchObject({ result: { content: [{ type: "text" }] } });
      expect(backendDb.sqlite.prepare("SELECT admin_id FROM drafts").get()).toEqual({ admin_id: 42 });
      const preview = await request(
        app,
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "studio_post_preview", arguments: { draft_id: 1 } } },
        `Bearer ${"a".repeat(16)}`,
      );
      expect(JSON.stringify(await preview.json())).toContain("MCP draft");
      expect(backendDb.sqlite.prepare("SELECT event_type, target FROM post_events WHERE event_type='studio.mcp.command'").get()).toEqual({
        event_type: "studio.mcp.command",
        target: "mcp",
      });
    } finally {
      backendDb.close();
    }
  });
});
