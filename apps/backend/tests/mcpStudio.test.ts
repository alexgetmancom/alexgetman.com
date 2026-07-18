import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiHandler } from "../src/api.js";
import { openBackendDb } from "../src/db/client.js";
import { studioMediaAssets } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";

function request(app: ReturnType<typeof createApiHandler>, body: unknown, authorization?: string) {
  return app(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
    }),
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
      const history = await request(
        app,
        { jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "studio_post_history", arguments: { draft_id: 1 } } },
        `Bearer ${"a".repeat(16)}`,
      );
      expect(JSON.stringify(await history.json())).toContain("content.draft.created");
      expect(backendDb.sqlite.prepare("SELECT event_type, target FROM post_events WHERE event_type='studio.mcp.command'").get()).toEqual({
        event_type: "studio.mcp.command",
        target: "mcp",
      });

      const capabilities = await request(
        app,
        { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "studio_capabilities", arguments: {} } },
        `Bearer ${"a".repeat(16)}`,
      );
      const capabilityResponse = (await capabilities.json()) as { result: { content: Array<{ text: string }> } };
      const [content] = capabilityResponse.result.content;
      expect(content).toBeDefined();
      const capabilityPayload = JSON.parse(content?.text ?? "") as Record<string, unknown>;
      expect(capabilityPayload).toHaveProperty("modules");
      expect(capabilityPayload).toHaveProperty("platforms");
      expect(JSON.stringify(capabilityPayload)).not.toContain('"required"');
    } finally {
      backendDb.close();
    }
  });

  it("uses the same owner-bound Video Studio commands as Telegram", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const token = "a".repeat(16);
      const config = loadConfig({ ADMIN_IDS: "42", MCP_STUDIO_TOKEN: token, MCP_STUDIO_ACTOR_ID: "42" });
      const app = createApiHandler({ config, backendDb, bot: null });
      const authorization = `Bearer ${token}`;
      const now = new Date().toISOString();
      backendDb.db
        .insert(studioMediaAssets)
        .values({
          adminId: 42,
          kind: "video",
          mimeType: "video/mp4",
          filename: "uploaded.mp4",
          localPath: "/tmp/uploaded.mp4",
          byteSize: 1,
          sha256: "video-asset",
          source: "mcp_upload",
          createdAt: now,
        })
        .run();
      const tools = await request(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, authorization);
      const listed = JSON.stringify(await tools.json());
      for (const name of [
        "studio_video_create",
        "studio_video_list",
        "studio_video_status",
        "studio_video_history",
        "studio_video_replace_targets",
        "studio_video_update_metadata",
        "studio_video_schedule",
        "studio_video_retry",
      ])
        expect(listed).toContain(name);

      await request(
        app,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "studio_video_create", arguments: { asset_id: 1 } },
        },
        authorization,
      );
      expect(backendDb.sqlite.prepare("SELECT admin_id, asset_key, studio_media_asset_id FROM video_drafts WHERE id=1").get()).toEqual({
        admin_id: 42,
        asset_key: "studio-asset-1",
        studio_media_asset_id: 1,
      });

      await request(
        app,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "studio_video_replace_targets", arguments: { video_draft_id: 1, targets: ["instagram_reels"] } },
        },
        authorization,
      );
      await request(
        app,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "studio_video_update_metadata",
            arguments: { video_draft_id: 1, target: "instagram_reels", metadata: { caption: "Ready from MCP #video" } },
          },
        },
        authorization,
      );
      expect(backendDb.sqlite.prepare("SELECT metadata_json FROM video_targets WHERE video_draft_id=1").get()).toEqual({
        metadata_json: '{"caption":"Ready from MCP #video"}',
      });
      expect(
        backendDb.sqlite
          .prepare("SELECT COUNT(*) AS count FROM post_events WHERE event_type='studio.mcp.command' AND post_key='video:1'")
          .get(),
      ).toEqual({ count: 3 });
    } finally {
      backendDb.close();
    }
  });

  it("uploads a transport-neutral asset and attaches it through the owner-bound MCP contract", async () => {
    const backendDb = openBackendDb(":memory:");
    const directory = mkdtempSync(join(tmpdir(), "alexgetman-mcp-media-"));
    try {
      const token = "a".repeat(16);
      const config = loadConfig({
        ADMIN_IDS: "42",
        MCP_STUDIO_TOKEN: token,
        MCP_STUDIO_ACTOR_ID: "42",
        STUDIO_MEDIA_DIR: directory,
      });
      const app = createApiHandler({ config, backendDb, bot: null });
      const authorization = `Bearer ${token}`;
      const created = await request(
        app,
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "studio_post_create", arguments: { text: "Asset draft" } } },
        authorization,
      );
      expect(created.status).toBe(200);
      const form = new FormData();
      form.set("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "agent-image.jpg", { type: "image/jpeg" }));
      const uploaded = await app(
        new Request("http://localhost/api/studio/media", { method: "POST", headers: { authorization }, body: form }),
      );
      expect(await uploaded.json()).toMatchObject({ asset_id: 1, kind: "photo", filename: "agent-image.jpg", byte_size: 4 });

      const attached = await request(
        app,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "studio_post_attach_media", arguments: { draft_id: 1, locale: "en", asset_ids: [1], replace: true } },
        },
        authorization,
      );
      expect(JSON.stringify(await attached.json())).toContain('\\"attached\\":true');
      expect(backendDb.sqlite.prepare("SELECT media_en_json FROM drafts WHERE id=1").get()).toMatchObject({
        media_en_json: expect.stringContaining('"asset_id":1'),
      });
      expect(backendDb.sqlite.prepare("SELECT source FROM studio_media_assets WHERE id=1").get()).toEqual({ source: "http_upload" });
    } finally {
      backendDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
