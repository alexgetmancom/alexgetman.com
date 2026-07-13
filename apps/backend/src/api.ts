import crypto from "node:crypto";
import fs from "node:fs";
import type { Bot } from "grammy";
import { type CommandAction, runCommandAction } from "./admin/actions.js";
import { commandCenterPayload, postDebugPayload } from "./admin/commandCenter.js";
import { renderCommandCenterLogin, renderDashboard } from "./admin/dashboard.js";
import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
import { commandAllowed } from "./httpAuth.js";
import { batchLikes, clientIpHash, likesInfo, metricsSummary, recordPageview, toggleLike } from "./services/engagement.js";
import { mcpResponse } from "./services/mcp.js";
import { pipelineStatusPayload } from "./services/pipeline.js";
import { allowPublicRequest } from "./services/publicRateLimit.js";
import { videoPath } from "./video/storage.js";

type ApiContext = {
  config: BackendConfig;
  backendDb: BackendDb;
  bot: Bot | null;
};
const COMMAND_CENTER_ORIGIN = "https://alexgetman.com";

function sameOriginCommandLogin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) return origin === COMMAND_CENTER_ORIGIN;
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === COMMAND_CENTER_ORIGIN;
  } catch {
    return false;
  }
}

export function createApiHandler(context: ApiContext) {
  return async (request: Request, path: string): Promise<Response> => {
    const { config, backendDb, bot } = context;
    const url = new URL(request.url);

    if (path === "/healthz" || path === "/tg-feed/healthz") return text("ok\n");
    if (path === "/readyz") {
      return json({
        ok: true,
        pipeline_db: config.PIPELINE_DB,
        pipeline_db_exists: fs.existsSync(config.PIPELINE_DB),
      });
    }
    const videoMatch = path.match(/^\/media\/video\/([A-Za-z0-9_-]{20,})$/);
    if (videoMatch && (request.method === "GET" || request.method === "HEAD")) {
      const filePath = videoPath(config, videoMatch[1] ?? "");
      if (!filePath) return text("not found\n", 404);
      const file = Bun.file(filePath);
      return new Response(request.method === "HEAD" ? null : file, {
        headers: {
          "content-type": file.type || "video/mp4",
          "content-length": String(file.size),
          "cache-control": "private, no-store",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }
    if (path === "/api/pipeline-status" && request.method === "GET") {
      if (config.commandCenterToken && !commandAllowed(request, config)) return text("unauthorized\n", 401);
      return json(pipelineStatusPayload(config, backendDb, Number(url.searchParams.get("week_offset") ?? 0) || 0));
    }
    if (path === "/api/pipeline-status/stream" && request.method === "GET") {
      if (config.commandCenterToken && !commandAllowed(request, config)) return text("unauthorized\n", 401);
      return sse((send) => {
        const weekOffset = Number(url.searchParams.get("week_offset") ?? 0) || 0;
        send("pipeline", pipelineStatusPayload(config, backendDb, weekOffset));
        return setInterval(() => send("pipeline", pipelineStatusPayload(config, backendDb, weekOffset)), 10_000);
      });
    }
    if (path === "/stats/pageview" && request.method === "POST") {
      const limit = allowPublicRequest(
        `pageview:${clientIpHash(request, config)}`,
        config.PUBLIC_RATE_LIMIT_PAGEVIEWS,
        config.PUBLIC_RATE_LIMIT_WINDOW_SECONDS,
      );
      if (!limit.allowed) return new Response(null, { status: 204 });
      const body = await request.json().catch(() => ({}) as { path?: string });
      recordPageview(backendDb, config, typeof body?.path === "string" ? body.path : "/");
      return new Response(null, { status: 204 });
    }
    if (path === "/stats" && request.method === "GET") {
      const summary = metricsSummary(backendDb);
      return html(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Alex Getman metrics</title></head><body><main><h1>Site metrics</h1><p>Total: ${summary.total}</p><p>Today: ${summary.today}</p><p>Last 7 days: ${summary.last7}</p><p>Updated: ${String(summary.updated_at ?? "-")}</p></main></body></html>`,
      );
    }
    if (path === "/pipeline-status" && request.method === "GET") {
      const target = new URL("/command-center", url);
      const weekOffset = url.searchParams.get("week_offset");
      if (weekOffset) target.searchParams.set("week_offset", weekOffset);
      return Response.redirect(target, 308);
    }
    if (path === "/command-center" && request.method === "GET") {
      const queryToken = url.searchParams.get("token");
      if (queryToken && commandAllowed(request, config)) {
        url.searchParams.delete("token");
        return new Response(null, {
          status: 303,
          headers: {
            location: `${url.pathname}${url.search}${url.hash}`,
            "set-cookie": `command_token=${encodeURIComponent(queryToken)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=15552000`,
          },
        });
      }
      if (!commandAllowed(request, config)) return html(renderCommandCenterLogin());
      return html(
        renderDashboard(
          config,
          backendDb,
          Number(url.searchParams.get("week_offset") ?? 0) || 0,
          url.searchParams.get("ref") ?? "",
          url.searchParams.get("message_id") ?? "",
        ),
      );
    }
    if (path === "/command-center" && request.method === "POST") {
      if (!sameOriginCommandLogin(request)) return text("forbidden\n", 403);
      const form = await request.formData().catch(() => new FormData());
      const token = form.get("token");
      if (typeof token !== "string" || !commandAllowed(request, config, token)) return html(renderCommandCenterLogin(true));
      return new Response(null, {
        status: 303,
        headers: {
          location: "/command-center",
          "set-cookie": `command_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=15552000`,
        },
      });
    }
    if (path === "/api/likes" && request.method === "GET") {
      const limit = allowPublicRequest(
        `likes:${clientIpHash(request, config)}`,
        config.PUBLIC_RATE_LIMIT_LIKES,
        config.PUBLIC_RATE_LIMIT_WINDOW_SECONDS,
      );
      if (!limit.allowed) return rateLimited(limit.retryAfter);
      const postId = url.searchParams.get("post_id")?.trim();
      return postId ? json(likesInfo(backendDb, postId, clientIpHash(request, config))) : json({ error: "Missing post_id parameter" }, 400);
    }
    if (path === "/api/likes/batch" && request.method === "GET") {
      const limit = allowPublicRequest(
        `likes:${clientIpHash(request, config)}`,
        config.PUBLIC_RATE_LIMIT_LIKES,
        config.PUBLIC_RATE_LIMIT_WINDOW_SECONDS,
      );
      if (!limit.allowed) return rateLimited(limit.retryAfter);
      const ids = (url.searchParams.get("ids") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 100);
      return json(batchLikes(backendDb, ids, clientIpHash(request, config)));
    }
    if (path === "/api/likes" && request.method === "POST") {
      const limit = allowPublicRequest(
        `likes:${clientIpHash(request, config)}`,
        config.PUBLIC_RATE_LIMIT_LIKES,
        config.PUBLIC_RATE_LIMIT_WINDOW_SECONDS,
      );
      if (!limit.allowed) return rateLimited(limit.retryAfter);
      const postId = url.searchParams.get("post_id")?.trim();
      return postId
        ? json(toggleLike(backendDb, postId, clientIpHash(request, config)))
        : json({ error: "Missing post_id parameter" }, 400);
    }
    if (path === "/api/mcp" && request.method === "GET")
      return sse((send) => {
        send("endpoint", `/api/mcp?connection_id=${crypto.randomUUID()}`);
        return setInterval(() => send("ping", new Date().toISOString()), 30_000);
      });
    if (path === "/api/mcp" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (body == null)
        return json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid JSON" },
        });
      return json(mcpResponse(backendDb, body, clientIpHash(request, config)));
    }
    if (path === config.WEBHOOK_PATH && request.method === "POST") {
      if (!safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", config.TELEGRAM_WEBHOOK_SECRET ?? ""))
        return text("forbidden\n", 403);
      const update = await request.json().catch(() => null);
      if (bot && update) await bot.handleUpdate(update as Parameters<Bot["handleUpdate"]>[0]);
      return text("ok\n");
    }
    if (path === "/api/command-center" && request.method === "GET")
      return commandAllowed(request, config) ? json(commandCenterPayload(config, backendDb)) : json({ detail: "forbidden" }, 403);
    if (path === "/api/ops-dashboard" && request.method === "GET")
      return commandAllowed(request, config)
        ? json({
            pipeline: pipelineStatusPayload(config, backendDb),
            ops: commandCenterPayload(config, backendDb),
          })
        : json({ detail: "forbidden" }, 403);
    if (path === "/api/post-debug" && request.method === "GET") {
      if (!commandAllowed(request, config)) return json({ detail: "forbidden" }, 403);
      const ref = url.searchParams.get("ref");
      if (!ref) return json({ detail: "missing ref" }, 400);
      const payload = postDebugPayload(backendDb, ref);
      return payload ? json(payload) : json({ detail: "not found" }, 404);
    }
    if (path === "/api/command-center/action" && request.method === "POST") {
      const body = await commandAction(request);
      if (!commandAllowed(request, config, body.token)) return json({ detail: "forbidden" }, 403);
      try {
        return json(await runCommandAction(backendDb, body, config));
      } catch (error) {
        return json({ detail: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    return text("not found\n", 404);
  };
}

async function commandAction(request: Request): Promise<CommandAction> {
  if (request.headers.get("content-type")?.includes("application/json")) return await request.json().catch(() => ({}) as CommandAction);
  const form = await request.formData().catch(() => new FormData());
  return Object.fromEntries(form.entries()) as unknown as CommandAction;
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
