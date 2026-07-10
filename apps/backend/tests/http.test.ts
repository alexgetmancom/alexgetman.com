import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDraftFromMessage, publishDraftToQueue } from "../src/bot.js";
import { openBackendDb } from "../src/db/client.js";
import { createHttpApp } from "../src/http.js";
import { enqueuePublishJob } from "../src/queue/publish.js";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "alexgetman-http-"));
  return openBackendDb(join(dir, "pipeline.db"), 5000);
}

describe("Hono backend routes", () => {
  it("protects command center JSON with legacy token sources", async () => {
    const backendDb = tempDb();
    try {
      const app = createHttpApp(loadConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb);
      expect((await app.request("/api/command-center")).status).toBe(403);
      expect((await app.request("/api/command-center", { headers: { "X-Command-Token": "secret" } })).status).toBe(200);
      expect((await app.request("/api/command-center?token=secret")).status).toBe(200);
    } finally {
      backendDb.close();
    }
  });

  it("returns post debug payload for queued publication refs", async () => {
    const backendDb = tempDb();
    try {
      enqueuePublishJob(backendDb, {
        messageId: 123,
        target: "devto",
        postKey: "telegram:alexgetmancom:123",
        payload: { title: "Debug", bodyMarkdown: "Body" },
      });
      const app = createHttpApp(loadConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb);
      const response = await app.request("/api/post-debug?ref=123", { headers: { "X-Admin-Token": "secret" } });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { ref: { postKey: string }; jobs: unknown[] };
      expect(payload.ref.postKey).toBe("telegram:alexgetmancom:123");
      expect(payload.jobs).toHaveLength(1);
    } finally {
      backendDb.close();
    }
  });

  it("keeps the legacy detailed pipeline-status wire format", async () => {
    const backendDb = tempDb();
    try {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Статус пайплайна", textEn: "Pipeline status", entities: [], media: [] });
      publishDraftToQueue(backendDb, draftId);
      const app = createHttpApp(loadConfig({}), backendDb);
      const response = await app.request("/api/pipeline-status");
      const payload = await response.json() as { ok: boolean; updated_at: string; feed: { items: number }; social_worker: { pipeline_db: string }; posts: Array<Record<string, unknown>> };
      expect(payload.ok).toBe(true);
      expect(payload.updated_at).toBeTruthy();
      expect(payload.feed.items).toBe(0);
      expect(payload.social_worker.pipeline_db).toBe("/data/pipeline.db");
      expect(payload.posts).toHaveLength(1);
      expect(payload.posts[0]).toMatchObject({ post_id: 1, text_en: "Pipeline status", site_ru: true, site_en: true, telegram: false });
      expect(payload.posts[0]?.targets).toEqual({});
      expect(payload.posts[0]?.metrics).toEqual({});
    } finally {
      backendDb.close();
    }
  });

  it("serves engagement, MCP and authenticated Telegram webhook routes", async () => {
    const backendDb = tempDb();
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-engagement-"));
    try {
      const app = createHttpApp(loadConfig({ SITE_METRICS_JSON: join(dir, "metrics.json"), LIKES_SALT: "salt", TELEGRAM_WEBHOOK_SECRET: "webhook-secret" }), backendDb);
      expect((await app.request("/stats/pageview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/post/" }) })).status).toBe(204);
      expect(JSON.parse(readFileSync(join(dir, "metrics.json"), "utf8"))).toMatchObject({ total: 1 });

      const like = await app.request("/api/likes?post_id=1", { method: "POST", headers: { "x-forwarded-for": "203.0.113.1" } });
      expect(await like.json()).toEqual({ likes: 1, user_liked: true });
      expect(await (await app.request("/api/likes?post_id=1", { headers: { "x-forwarded-for": "203.0.113.1" } })).json()).toEqual({ likes: 1, user_liked: true });

      const initialized = await app.request("/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
      expect(await initialized.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } });
      expect((await app.request("/tg-feed/webhook", { method: "POST", body: "{}" })).status).toBe(403);
      expect((await app.request("/tg-feed/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" }, body: "{}" })).status).toBe(200);
    } finally {
      backendDb.close();
    }
  });

  it("runs authenticated command-center repair actions", async () => {
    const backendDb = tempDb();
    try {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Исходник", textEn: "Original", entities: [], media: [] });
      const postId = publishDraftToQueue(backendDb, draftId);
      const app = createHttpApp(loadConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb);
      const response = await app.request("/api/command-center/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "edit_en", ref: `post:${postId}`, text_en: "Edited English", token: "secret" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, post_id: postId, text_en: true });
      expect(backendDb.sqlite.prepare("SELECT text FROM post_locales WHERE post_id=? AND locale='en'").get(postId)).toEqual({ text: "Edited English" });
      expect((backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM ops_actions").get() as { count: number }).count).toBe(1);
      expect((backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM site_jobs WHERE post_id=?").get(postId) as { count: number }).count).toBe(3);
    } finally {
      backendDb.close();
    }
  });

  it("serves generated Markdown safely and renders the full command center", async () => {
    const backendDb = tempDb();
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-markdown-"));
    writeFileSync(join(dir, "auth.md"), "# auth.md\n");
    try {
      backendDb.sqlite.prepare("INSERT INTO credential_checks(target,status,required_env_json,missing_env_json,last_checked_at) VALUES ('telegram','ready','[]','[]',?)").run(new Date().toISOString());
      const app = createHttpApp(loadConfig({ COMMAND_CENTER_TOKEN: "secret", SITE_PUBLIC_DIR: dir, SITE_METRICS_JSON: join(dir, "metrics.json") }), backendDb);
      const markdown = await app.request("/auth.md");
      expect(markdown.status).toBe(200);
      expect(markdown.headers.get("content-type")).toContain("text/markdown");
      expect(await markdown.text()).toBe("# auth.md\n");
      expect((await app.request("/%2e%2e/package.json")).status).toBe(404);
      const dashboard = await app.request("/command-center?tab=diagnostics&token=secret");
      const html = await dashboard.text();
      expect(dashboard.status).toBe(200);
      expect(html).toContain("Publications");
      expect(html).toContain("Credentials");
      expect(html).toContain("Diagnostics");
      expect(html).toContain("Lifecycle");
      const payload = await (await app.request("/api/command-center?token=secret")).json() as { credentials: Array<{ target: string }> };
      expect(payload.credentials).toEqual([expect.objectContaining({ target: "telegram" })]);
    } finally {
      backendDb.close();
    }
  });
});
