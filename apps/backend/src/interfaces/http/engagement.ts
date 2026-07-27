import { escapeHtml, html, json, rateLimited } from "../../foundation/http-response.js";
import type { RouteModule } from "./context.js";

export const engagementRoutes: RouteModule = (app, { engagement }) => {
  app.post("/stats/pageview", async (c) => {
    const body = await c.req.raw.json().catch(() => ({}) as { path?: string });
    engagement.recordPageview(c.req.raw, typeof body?.path === "string" ? body.path : "/");
    return new Response(null, { status: 204 });
  });

  app.get("/stats", () => {
    const summary = engagement.metrics();
    return html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alex Getman metrics</title></head><body><main><h1>Site metrics</h1><p>Total: ${escapeHtml(summary.total)}</p><p>Today: ${escapeHtml(summary.today)}</p><p>Last 7 days: ${escapeHtml(summary.last7)}</p><p>Updated: ${escapeHtml(summary.updated_at ?? "-")}</p></main></body></html>`,
    );
  });

  app.get("/api/likes", (c) => {
    const limit = engagement.allowLikes(c.req.raw);
    if (!limit.allowed) return rateLimited(limit.retryAfter);
    const postId = c.req.query("post_id")?.trim();
    return postId ? json(engagement.likes(c.req.raw, postId)) : json({ error: "Missing post_id parameter" }, 400);
  });

  app.get("/api/likes/batch", (c) => {
    const limit = engagement.allowLikes(c.req.raw);
    if (!limit.allowed) return rateLimited(limit.retryAfter);
    const ids = (c.req.query("ids") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 100);
    return json(engagement.likesBatch(c.req.raw, ids));
  });

  app.post("/api/likes", (c) => {
    const limit = engagement.allowLikes(c.req.raw);
    if (!limit.allowed) return rateLimited(limit.retryAfter);
    const postId = c.req.query("post_id")?.trim();
    return postId ? json(engagement.toggleLike(c.req.raw, postId)) : json({ error: "Missing post_id parameter" }, 400);
  });
};
