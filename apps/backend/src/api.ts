import crypto from "node:crypto";
import fs from "node:fs";
import type { Bot } from "grammy";
import { Hono } from "hono";
import { videoPath } from "./content/video-assets.js";
import type { BackendDb } from "./db/client.js";
import { engagementService } from "./engagement/service.js";
import type { BackendConfig } from "./foundation/config.js";
import { commandAllowed } from "./foundation/http-auth.js";
import { mcpResponse } from "./interfaces/mcp.js";
import type { OperationsCommand } from "./operations/contracts.js";
import { renderCommandCenterLogin, renderDashboard } from "./operations/dashboard.js";
import { operationsService } from "./operations/service.js";
import { studioServices } from "./studio/services/index.js";

type ApiContext = {
  config: BackendConfig;
  backendDb: BackendDb;
  bot: Bot | null;
};
const botInitialization = new WeakMap<Bot, Promise<void>>();
const apps = new WeakMap<ApiContext, Hono>();

function initializeWebhookBot(bot: Bot): Promise<void> {
  const existing = botInitialization.get(bot);
  if (existing) return existing;
  const initialization = bot.init();
  botInitialization.set(bot, initialization);
  return initialization;
}

function sameOriginCommandLogin(request: Request, config: BackendConfig): boolean {
  const expectedOrigin = new URL(config.COMMAND_CENTER_URL).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === expectedOrigin;
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}

/** One Hono app per runtime context (config/backendDb/bot identity), built once
 * and reused for every request — routes and the services they close over don't
 * change for the life of that context. */
export function createApiHandler(context: ApiContext) {
  const app = apps.get(context) ?? buildApp(context);
  apps.set(context, app);
  return async (request: Request): Promise<Response> => app.fetch(request);
}

function buildApp({ config, backendDb, bot }: ApiContext): Hono {
  const operations = operationsService(backendDb, config);
  const engagement = engagementService(backendDb, config);
  // Trailing slashes reached this dispatcher un-normalized under the old Astro
  // catch-all route (`/api/${route}`.replace(/\/$/, "")); keep matching them.
  const app = new Hono({ strict: false });

  app.get("/healthz", () => text("ok\n"));
  app.get("/tg-feed/healthz", () => text("ok\n"));
  app.get("/readyz", () => json({ ok: true, pipeline_db: config.PIPELINE_DB, pipeline_db_exists: fs.existsSync(config.PIPELINE_DB) }));

  app.on(["GET", "HEAD"], "/media/video/:token{[A-Za-z0-9_-]{20,}}", (c) => {
    const filePath = videoPath(config, c.req.param("token"));
    if (!filePath) return text("not found\n", 404);
    const file = Bun.file(filePath);
    return new Response(c.req.method === "HEAD" ? null : file, {
      headers: {
        "content-type": file.type || "video/mp4",
        "content-length": String(file.size),
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  });

  app.get("/api/pipeline-status", (c) => {
    if (config.commandCenterToken && !commandAllowed(c.req.raw, config)) return text("unauthorized\n", 401);
    return json(operations.pipeline(Number(c.req.query("week_offset") ?? 0) || 0));
  });

  app.get("/api/pipeline-status/stream", (c) => {
    if (config.commandCenterToken && !commandAllowed(c.req.raw, config)) return text("unauthorized\n", 401);
    const weekOffset = Number(c.req.query("week_offset") ?? 0) || 0;
    return sse((send) => {
      send("pipeline", operations.pipeline(weekOffset));
      return setInterval(() => send("pipeline", operations.pipeline(weekOffset)), 10_000);
    });
  });

  app.post("/stats/pageview", async (c) => {
    const body = await c.req.raw.json().catch(() => ({}) as { path?: string });
    engagement.recordPageview(c.req.raw, typeof body?.path === "string" ? body.path : "/");
    return new Response(null, { status: 204 });
  });

  app.get("/stats", () => {
    const summary = engagement.metrics();
    return html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alex Getman metrics</title></head><body><main><h1>Site metrics</h1><p>Total: ${summary.total}</p><p>Today: ${summary.today}</p><p>Last 7 days: ${summary.last7}</p><p>Updated: ${String(summary.updated_at ?? "-")}</p></main></body></html>`,
    );
  });

  app.get("/pipeline-status", (c) => {
    const target = new URL("/command-center", c.req.url);
    const weekOffset = c.req.query("week_offset");
    if (weekOffset) target.searchParams.set("week_offset", weekOffset);
    return Response.redirect(target, 308);
  });

  app.get("/command-center", (c) => {
    const request = c.req.raw;
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("token");
    if (queryToken && commandAllowed(request, config)) return queryTokenRedirect(url, "command_token", queryToken);
    if (!commandAllowed(request, config)) return html(renderCommandCenterLogin());
    return html(
      renderDashboard(
        config,
        backendDb,
        Number(url.searchParams.get("week_offset") ?? 0) || 0,
        url.searchParams.get("ref") ?? "",
        url.searchParams.get("message_id") ?? "",
        url.searchParams.get("tab") ?? undefined,
        url.searchParams.get("locale") ?? undefined,
      ),
    );
  });

  app.post("/command-center", async (c) => {
    const request = c.req.raw;
    if (!sameOriginCommandLogin(request, config)) return text("forbidden\n", 403);
    const form = await request.formData().catch(() => new FormData());
    const token = form.get("token");
    if (typeof token !== "string" || !commandAllowed(request, config, token)) return html(renderCommandCenterLogin(true));
    return loginRedirect("/command-center", "command_token", token);
  });

  app.post("/command-center/studio/acknowledge", async (c) => {
    const request = c.req.raw;
    if (!commandAllowed(request, config) || !sameOriginCommandLogin(request, config)) return text("forbidden\n", 403);
    const actorId = config.MCP_STUDIO_ACTOR_ID;
    const form = await request.formData().catch(() => new FormData());
    const id = Number(form.get("id"));
    if (actorId && Number.isSafeInteger(id)) studioServices(backendDb, config).notifications.acknowledge(actorId, id);
    return new Response(null, { status: 303, headers: { location: "/command-center?tab=studio" } });
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

  app.get("/api/mcp", () =>
    sse((send) => {
      send("endpoint", `/api/mcp?connection_id=${crypto.randomUUID()}`);
      return setInterval(() => send("ping", new Date().toISOString()), 30_000);
    }),
  );

  app.post("/api/mcp", async (c) => {
    const body = await c.req.raw.json().catch(() => null);
    if (body == null) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
    return json(await mcpResponse(backendDb, config, body, engagement.clientKey(c.req.raw), mcpStudioActor(c.req.raw, config)));
  });

  app.post("/api/studio/media", async (c) => {
    const request = c.req.raw;
    const actorId = mcpStudioActor(request, config);
    if (!actorId) return text("forbidden\n", 403);
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return json({ error: "Expected multipart field: file" }, 400);
    try {
      const asset = await studioServices(backendDb, config).media.import(actorId, {
        filename: file.name,
        contentType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
        source: "http_upload",
      });
      return json({ asset_id: asset.id, kind: asset.kind, filename: asset.filename, byte_size: asset.byteSize });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post(config.WEBHOOK_PATH, async (c) => {
    const request = c.req.raw;
    if (!safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", config.TELEGRAM_WEBHOOK_SECRET ?? ""))
      return text("forbidden\n", 403);
    const update = await request.json().catch(() => null);
    if (bot && update) {
      await initializeWebhookBot(bot);
      await bot.handleUpdate(update as Parameters<Bot["handleUpdate"]>[0]);
    }
    return text("ok\n");
  });

  app.get("/api/command-center", (c) =>
    commandAllowed(c.req.raw, config) ? json(operations.dashboard()) : json({ detail: "forbidden" }, 403),
  );

  app.get("/api/ops-dashboard", (c) =>
    commandAllowed(c.req.raw, config)
      ? json({ pipeline: operations.pipeline(), ops: operations.dashboard() })
      : json({ detail: "forbidden" }, 403),
  );

  app.get("/api/post-debug", (c) => {
    if (!commandAllowed(c.req.raw, config)) return json({ detail: "forbidden" }, 403);
    const ref = c.req.query("ref");
    if (!ref) return json({ detail: "missing ref" }, 400);
    const payload = operations.postDebug(ref);
    return payload ? json(payload) : json({ detail: "not found" }, 404);
  });

  app.post("/api/command-center/action", async (c) => {
    const body = await commandAction(c.req.raw);
    if (!commandAllowed(c.req.raw, config, body.token)) return json({ detail: "forbidden" }, 403);
    try {
      return json(await operations.command(body));
    } catch (error) {
      return json({ detail: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.notFound(() => text("not found\n", 404));
  return app;
}

function sessionCookie(name: string, token: string): string {
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=15552000`;
}

/** Query-token sign-in: promote the token into a cookie and redirect back to the
 * same URL with it stripped, so it never lingers in browser history or logs. */
function queryTokenRedirect(url: URL, cookieName: string, token: string): Response {
  const clean = new URL(url);
  clean.searchParams.delete("token");
  return new Response(null, {
    status: 303,
    headers: { location: `${clean.pathname}${clean.search}${clean.hash}`, "set-cookie": sessionCookie(cookieName, token) },
  });
}

function loginRedirect(location: string, cookieName: string, token: string): Response {
  return new Response(null, { status: 303, headers: { location, "set-cookie": sessionCookie(cookieName, token) } });
}

async function commandAction(request: Request): Promise<OperationsCommand> {
  if (request.headers.get("content-type")?.includes("application/json")) return await request.json().catch(() => ({}) as OperationsCommand);
  const form = await request.formData().catch(() => new FormData());
  return Object.fromEntries(form.entries()) as unknown as OperationsCommand;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function rateLimited(retryAfter: number): Response {
  return json({ detail: "rate limit exceeded" }, 429, {
    "retry-after": String(retryAfter),
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function sse(start: (send: (event: string, data: unknown) => void) => ReturnType<typeof setInterval>): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          new TextEncoder().encode(`event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`),
        );
      timer = start(send);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function safeEqual(received: string, expected: string): boolean {
  if (!received || !expected) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function mcpStudioActor(request: Request, config: BackendConfig): number | null {
  if (!config.MCP_STUDIO_TOKEN || !config.MCP_STUDIO_ACTOR_ID) return null;
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  return safeEqual(token, config.MCP_STUDIO_TOKEN) ? config.MCP_STUDIO_ACTOR_ID : null;
}
