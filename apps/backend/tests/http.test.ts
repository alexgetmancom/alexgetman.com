import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiHandler } from "../src/api.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { openBackendDb } from "../src/db/client.js";
import { loadConfig } from "../src/foundation/config.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { enqueuePublishJob } from "../src/publishing/queue.js";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "alexgetman-http-"));
  return openBackendDb(join(dir, "pipeline.db"), 5000);
}

function createApiApp(
  config: ReturnType<typeof loadConfig>,
  backendDb: ReturnType<typeof openBackendDb>,
  bot: import("grammy").Bot | null = null,
) {
  const handler = createApiHandler({ config, backendDb, bot });
  return {
    request(path: string, init?: RequestInit) {
      const request = new Request(`http://localhost${path}`, init);
      return handler(request, new URL(request.url).pathname);
    },
  };
}

describe("Astro endpoint controller", () => {
  it("protects command center JSON with legacy token sources", async () => {
    const backendDb = tempDb();
    try {
      const app = createApiApp(loadConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb);
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
      const app = createApiApp(loadConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb);
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
      const draftId = createDraftFromMessage(backendDb, 42, {
        text: "Статус пайплайна",
        textEn: "Pipeline status",
        entities: [],
        media: [],
      });
      publishDraftToQueue(backendDb, draftId);
      const app = createApiApp(loadConfig({}), backendDb);
      const response = await app.request("/api/pipeline-status");
      const payload = (await response.json()) as {
        ok: boolean;
        updated_at: string;
        feed: { items: number };
        social_worker: { pipeline_db: string };
        posts: Array<Record<string, unknown>>;
      };
      expect(payload.ok).toBe(true);
      expect(payload.updated_at).toBeTruthy();
      expect(payload.feed.items).toBe(1);
      expect(payload.social_worker.pipeline_db).toBe("/data/pipeline.db");
      expect(payload.posts).toHaveLength(1);
      expect(payload.posts[0]).toMatchObject({ post_id: 1, text_en: "Pipeline status", site_ru: true, site_en: true, telegram: false });
      expect(payload.posts[0]?.targets).toEqual({});
      expect(payload.posts[0]?.metrics).toEqual({});
    } finally {
      backendDb.close();
    }
  });

  it("protects pipeline JSON when the command center is configured", async () => {
    const backendDb = tempDb();
    try {
      const app = createApiApp(loadConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb);
      expect((await app.request("/api/pipeline-status")).status).toBe(401);
      expect((await app.request("/api/pipeline-status", { headers: { "X-Admin-Token": "secret" } })).status).toBe(200);
    } finally {
      backendDb.close();
    }
  });

  it("serves engagement, MCP and authenticated Telegram webhook routes", async () => {
    const backendDb = tempDb();
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-engagement-"));
    try {
      const init = mock(async () => undefined);
      const handleUpdate = mock(async () => undefined);
      const app = createApiApp(
        loadConfig({
          SITE_METRICS_JSON: join(dir, "metrics.json"),
          LIKES_SALT: "salt",
          TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
          TRUSTED_CLIENT_IP_HEADER: "x-real-ip",
        }),
        backendDb,
        { init, handleUpdate } as unknown as import("grammy").Bot,
      );
      expect(
        (
          await app.request("/stats/pageview", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: "/post/" }),
          })
        ).status,
      ).toBe(204);
      expect(backendDb.sqlite.prepare("SELECT count FROM site_pageviews WHERE path=?").get("/post/")).toEqual({ count: 1 });

      const like = await app.request("/api/likes?post_id=1", { method: "POST", headers: { "x-forwarded-for": "203.0.113.1" } });
      expect(await like.json()).toEqual({ likes: 1, user_liked: true });
      expect(await (await app.request("/api/likes?post_id=1", { headers: { "x-forwarded-for": "203.0.113.1" } })).json()).toEqual({
        likes: 1,
        user_liked: true,
      });

      const initialized = await app.request("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      });
      expect(await initialized.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } });
      for (let index = 0; index < 5; index++) {
        const response = await app.request("/api/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": "203.0.113.1", "x-forwarded-for": `198.51.100.${index + 1}` },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: index,
            method: "tools/call",
            params: { name: "submit_feedback", arguments: { message: `Feedback ${index}` } },
          }),
        });
        expect(await response.json()).toMatchObject({ result: { content: [{ type: "text" }] } });
      }
      const limitedFeedback = await app.request("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.99" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: { name: "submit_feedback", arguments: { message: "Too many requests" } },
        }),
      });
      expect(await limitedFeedback.json()).toMatchObject({ error: { code: -32000, message: "rate limit exceeded" } });
      expect((await app.request("/tg-feed/webhook", { method: "POST", body: "{}" })).status).toBe(403);
      expect(
        (
          await app.request("/tg-feed/webhook", {
            method: "POST",
            headers: { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" },
            body: "{}",
          })
        ).status,
      ).toBe(200);
      expect(handleUpdate).toHaveBeenCalledTimes(1);
      expect(init).toHaveBeenCalledTimes(1);
    } finally {
      backendDb.close();
    }
  });

  it("runs authenticated command-center repair actions", async () => {
    const backendDb = tempDb();
    try {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Исходник", textEn: "Original", entities: [], media: [] });
      const postId = publishDraftToQueue(backendDb, draftId);
      const app = createApiApp(loadConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb);
      const response = await app.request("/api/command-center/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "edit_en", ref: `post:${postId}`, text_en: "Edited English", token: "secret" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, post_id: postId, text_en: true });
      expect(backendDb.sqlite.prepare("SELECT text FROM post_locales WHERE post_id=? AND locale='en'").get(postId)).toEqual({
        text: "Edited English",
      });
      expect((backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM ops_actions").get() as { count: number }).count).toBe(1);
      expect(
        (backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM site_jobs WHERE post_id=?").get(postId) as { count: number }).count,
      ).toBe(3);
    } finally {
      backendDb.close();
    }
  });

  it("renders the full command center through the framework-neutral controller", async () => {
    const backendDb = tempDb();
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-markdown-"));
    try {
      backendDb.sqlite
        .prepare(
          "INSERT INTO credential_checks(target,status,required_env_json,missing_env_json,last_checked_at) VALUES ('telegram','ready','[]','[]',?)",
        )
        .run(new Date().toISOString());
      const app = createApiApp(
        loadConfig({ COMMAND_CENTER_TOKEN: "secret", SITE_PUBLIC_DIR: dir, SITE_METRICS_JSON: join(dir, "metrics.json") }),
        backendDb,
      );
      const login = await app.request("/command-center");
      expect(login.status).toBe(200);
      expect(await login.text()).toContain("Введите Command Center token");
      const signIn = await app.request("/command-center", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://alexgetman.com" },
        body: "token=secret",
      });
      expect(signIn.status).toBe(303);
      const cookie = signIn.headers.get("set-cookie");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Max-Age=15552000");
      const crossSiteSignIn = await app.request("/command-center", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://example.com" },
        body: "token=secret",
      });
      expect(crossSiteSignIn.status).toBe(403);
      const dashboard = await app.request("/command-center", { headers: { cookie: cookie ?? "" } });
      const html = await dashboard.text();
      expect(dashboard.status).toBe(200);
      expect(html).toContain("Pipeline");
      expect(html).toContain("Credentials");
      expect(html).toContain("Health: credentials и diagnostics");
      expect(html).toContain("Lifecycle");
      expect(html).toContain("font:16px -apple-system");
      expect(html).not.toContain("width: 22px; text-align: center; font-family: monospace");
      const payload = (await (await app.request("/api/command-center?token=secret")).json()) as { credentials: Array<{ target: string }> };
      expect(payload.credentials).toEqual([expect.objectContaining({ target: "telegram" })]);
    } finally {
      backendDb.close();
    }
  });

  it("streams current pipeline snapshots as SSE", async () => {
    const backendDb = tempDb();
    try {
      const app = createApiApp(loadConfig({}), backendDb);
      const response = await app.request("/api/pipeline-status/stream");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      const first = await reader?.read();
      await reader?.cancel();
      expect(new TextDecoder().decode(first?.value)).toContain("event: pipeline");
    } finally {
      backendDb.close();
    }
  });
});
