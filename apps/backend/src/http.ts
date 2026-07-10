import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import crypto from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
import { commandAllowed } from "./httpAuth.js";
import { commandCenterPayload, postDebugPayload } from "./services/commandCenter.js";
import { pipelineStatusPayload } from "./services/pipeline.js";
import { batchLikes, clientIpHash, likesInfo, metricsSummary, recordPageview, toggleLike } from "./services/engagement.js";
import { mcpResponse } from "./services/mcp.js";
import { runCommandAction, type CommandAction } from "./services/actions.js";
import { renderDashboard } from "./services/dashboard.js";

export function createHttpApp(config: BackendConfig, backendDb: BackendDb) {
  const app = new Hono();

  app.get("/healthz", (c) => c.text("ok\n"));
  app.get("/tg-feed/healthz", (c) => c.text("ok\n"));
  app.get("/readyz", (c) => {
    const status = pipelineStatusPayload(config, backendDb);
    return c.json({
      ok: true,
      pipeline_db: status.pipelineDb.path,
      pipeline_db_exists: status.pipelineDb.exists,
    });
  });

  app.get("/api/pipeline-status", (c) => c.json(pipelineStatusPayload(config, backendDb, Number(c.req.query("week_offset") ?? 0) || 0)));

  app.post("/stats/pageview", async (c) => {
    const body: { path?: string } = await c.req.json<{ path?: string }>().catch(() => ({}));
    recordPageview(backendDb, config, body.path ?? "/");
    return c.body(null, 204);
  });

  app.get("/stats", (c) => {
    const summary = metricsSummary(config);
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alex Getman metrics</title></head><body><main><h1>Site metrics</h1><p>Total: ${summary.total}</p><p>Today: ${summary.today}</p><p>Last 7 days: ${summary.last7}</p><p>Updated: ${String(summary.updated_at ?? "-")}</p></main></body></html>`);
  });

  app.get("/api/likes", (c) => {
    const postId = c.req.query("post_id")?.trim();
    return postId ? c.json(likesInfo(backendDb, postId, clientIpHash(c, config))) : c.json({ error: "Missing post_id parameter" }, 400);
  });

  app.get("/api/likes/batch", (c) => {
    const ids = (c.req.query("ids") ?? "").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 100);
    return c.json(batchLikes(backendDb, ids, clientIpHash(c, config)));
  });

  app.post("/api/likes", (c) => {
    const postId = c.req.query("post_id")?.trim();
    return postId ? c.json(toggleLike(backendDb, postId, clientIpHash(c, config))) : c.json({ error: "Missing post_id parameter" }, 400);
  });

  app.get("/api/mcp", (c) => streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "endpoint", data: `/api/mcp?connection_id=${crypto.randomUUID()}` });
    while (!stream.aborted) {
      await stream.sleep(30_000);
      await stream.writeSSE({ event: "ping", data: new Date().toISOString() });
    }
  }));

  app.post("/api/mcp", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body == null) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
    const client = c.req.header("x-forwarded-for")?.split(",", 1)[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    return c.json(mcpResponse(backendDb, body, client));
  });

  app.post(config.WEBHOOK_PATH, async (c) => {
    if (!safeEqual(c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "", config.TELEGRAM_WEBHOOK_SECRET ?? "")) return c.text("forbidden\n", 403);
    await c.req.json().catch(() => ({}));
    return c.text("ok\n");
  });

  app.get("/api/command-center", (c) => {
    if (!commandAllowed(c, config)) return c.json({ detail: "forbidden" }, 403);
    return c.json(commandCenterPayload(config, backendDb));
  });

  app.get("/api/ops-dashboard", (c) => {
    if (!commandAllowed(c, config)) return c.json({ detail: "forbidden" }, 403);
    return c.json({ pipeline: pipelineStatusPayload(config, backendDb), ops: commandCenterPayload(config, backendDb) });
  });

  app.get("/api/post-debug", (c) => {
    if (!commandAllowed(c, config)) return c.json({ detail: "forbidden" }, 403);
    const ref = c.req.query("ref");
    if (!ref) return c.json({ detail: "missing ref" }, 400);
    const payload = postDebugPayload(backendDb, ref);
    if (!payload) return c.json({ detail: "not found" }, 404);
    return c.json(payload);
  });

  app.post("/api/command-center/action", async (c) => {
    const body = c.req.header("content-type")?.includes("application/json")
      ? await c.req.json<CommandAction>().catch(() => ({} as CommandAction))
      : await c.req.parseBody().then((value) => value as unknown as CommandAction);
    if (!commandAllowed(c, config, body.token)) return c.json({ detail: "forbidden" }, 403);
    try {
      return c.json(runCommandAction(backendDb, body));
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/pipeline-status", (c) => {
    const payload = pipelineStatusPayload(config, backendDb);
    const rows = payload.jobs
      .slice(0, 20)
      .map((job) => `<tr><td>${job.messageId}</td><td>${job.target}</td><td>${job.status}</td><td>${job.updatedAt}</td></tr>`)
      .join("");
    return c.html(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Pipeline status</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
  <h1>Pipeline status</h1>
  <p>ok: ${payload.ok}</p>
  <p>git: ${payload.gitRevision ?? "unknown"}</p>
  <p>db: ${payload.pipelineDb.path}</p>
  <h2>Metrics</h2>
  <pre>${escapeHtml(JSON.stringify(payload.metrics, null, 2))}</pre>
  <h2>Jobs</h2>
  <table><thead><tr><th>Message</th><th>Target</th><th>Status</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>
</body>
</html>`);
  });

  app.get("/command-center", (c) => {
    if (!commandAllowed(c, config)) return c.text("forbidden\n", 403);
    return c.html(renderDashboard(commandCenterPayload(config, backendDb), c.req.query("tab")));
  });

  app.get("/feed.json", async (c) => {
    let body: string;
    try {
      body = await readFile(config.FEED_JSON, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        body = `${JSON.stringify({ updated_at: new Date().toISOString(), channel: config.CHANNEL_USERNAME, items: [] }, null, 2)}\n`;
      } else {
        throw error;
      }
    }
    return c.body(body, 200, { "content-type": "application/json; charset=utf-8" });
  });

  app.use("/media/*", serveStatic({ root: "/" }));

  app.get("/*", async (c) => {
    if (!c.req.path.endsWith(".md")) return c.text("not found\n", 404);
    const root = path.resolve(config.SITE_PUBLIC_DIR);
    const relative = decodeURIComponent(c.req.path).replace(/^\/+/, "");
    const filePath = path.resolve(root, relative);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return c.text("forbidden\n", 403);
    try {
      const content = await readFile(filePath, "utf8");
      recordPageview(backendDb, config, c.req.path.replace(/\.md$/, "") || "/");
      return c.body(content, 200, { "content-type": "text/markdown; charset=utf-8" });
    } catch {
      return c.text("Markdown file not found\n", 404);
    }
  });

  return app;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function safeEqual(received: string, expected: string): boolean {
  if (!received || !expected) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
