import { commandAllowed, sameOriginCommandLogin } from "../../foundation/http-auth.js";
import { html, json, loginRedirect, queryTokenRedirect, sse, text } from "../../foundation/http-response.js";
import { parseStudioLocale } from "../../foundation/locale.js";
import { measureMemorySync } from "../../observability/memory.js";
import { trackUsageAsync, trackUsageSync } from "../../observability/usage.js";
import { type CommandAction, commandActionSchema } from "../../operations/commands.js";
import {
  invalidateDashboardRenderCache,
  renderCommandCenterLogin,
  renderDashboard,
  renderDashboardPublicationDetails,
} from "../web/dashboard.js";
import type { RouteModule } from "./context.js";

export const commandCenterRoutes: RouteModule = (app, { config, backendDb, operations, studio }) => {
  app.get("/api/pipeline-status", (c) => {
    if (!commandAllowed(c.req.raw, config)) return text("unauthorized\n", 401);
    const weekOffset = Number(c.req.query("week_offset") ?? 0) || 0;
    return json(
      measureMemorySync("command_center.pipeline.render", { route: "/api/pipeline-status", weekOffset }, () =>
        trackUsageSync(backendDb, "command_center.pipeline.view", () =>
          operations.pipeline(weekOffset, 7, 0, undefined, { includeSamples: true }),
        ),
      ),
    );
  });

  app.get("/api/pipeline-status/stream", (c) => {
    if (!commandAllowed(c.req.raw, config)) return text("unauthorized\n", 401);
    const weekOffset = Number(c.req.query("week_offset") ?? 0) || 0;
    return sse((send) => {
      send(
        "pipeline",
        measureMemorySync("command_center.pipeline.render", { route: "/api/pipeline-status/stream", weekOffset }, () =>
          trackUsageSync(backendDb, "command_center.pipeline.view", () =>
            operations.pipeline(weekOffset, 7, 0, undefined, { includeSamples: true }),
          ),
        ),
      );
      return setInterval(
        () =>
          send(
            "pipeline",
            measureMemorySync("command_center.pipeline.render", { route: "/api/pipeline-status/stream", weekOffset }, () =>
              trackUsageSync(backendDb, "command_center.pipeline.view", () =>
                operations.pipeline(weekOffset, 7, 0, undefined, { includeSamples: true }),
              ),
            ),
          ),
        10_000,
      );
    });
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
    if (!commandAllowed(request, config)) return html(renderCommandCenterLogin(parseStudioLocale(url.searchParams.get("locale"))));
    return html(
      measureMemorySync("command_center.dashboard.render", dashboardMemoryContext(url), () =>
        trackUsageSync(backendDb, "command_center.dashboard.render", () =>
          renderDashboard(
            config,
            backendDb,
            Number(url.searchParams.get("week_offset") ?? 0) || 0,
            url.searchParams.get("ref") ?? "",
            url.searchParams.get("message_id") ?? "",
            url.searchParams.get("tab") ?? undefined,
            url.searchParams.get("locale") ?? undefined,
            url.searchParams.get("panel") ?? undefined,
            url.searchParams.get("period") ?? undefined,
            url.searchParams.get("view") ?? undefined,
            url.searchParams.get("metric") ?? undefined,
            url.searchParams.get("video_view") ?? undefined,
          ),
        ),
      ),
    );
  });

  app.post("/command-center", async (c) => {
    const request = c.req.raw;
    if (!sameOriginCommandLogin(request, config)) return text("forbidden\n", 403);
    const form = await request.formData().catch(() => new FormData());
    const token = form.get("token");
    if (typeof token !== "string" || !commandAllowed(request, config, token))
      return html(renderCommandCenterLogin(parseStudioLocale(form.get("locale")), true));
    return loginRedirect("/command-center", "command_token", token);
  });

  app.post("/command-center/studio/acknowledge", async (c) => {
    const request = c.req.raw;
    if (!commandAllowed(request, config) || !sameOriginCommandLogin(request, config)) return text("forbidden\n", 403);
    const actorId = config.MCP_STUDIO_ACTOR_ID;
    const form = await request.formData().catch(() => new FormData());
    const id = Number(form.get("id"));
    if (actorId && Number.isSafeInteger(id)) studio.notifications.acknowledge(actorId, id);
    invalidateDashboardRenderCache(backendDb);
    const locale = new URL(request.url).searchParams.get("locale") === "en" ? "&locale=en" : "";
    return new Response(null, { status: 303, headers: { location: `/command-center?tab=studio${locale}` } });
  });

  app.get("/api/command-center", (c) =>
    commandAllowed(c.req.raw, config)
      ? json(
          measureMemorySync("command_center.dashboard.payload", { route: "/api/command-center" }, () =>
            trackUsageSync(backendDb, "command_center.dashboard.payload", () => operations.dashboard()),
          ),
        )
      : json({ detail: "forbidden" }, 403),
  );

  app.get("/api/command-center/fingerprint", (c) =>
    commandAllowed(c.req.raw, config)
      ? json(trackUsageSync(backendDb, "command_center.fingerprint.poll", () => operations.fingerprint()))
      : json({ detail: "forbidden" }, 403),
  );

  app.get("/api/command-center/publication-details", (c) => {
    if (!commandAllowed(c.req.raw, config)) return json({ detail: "forbidden" }, 403);
    const requestedPeriod = Number(c.req.query("period") ?? 1);
    const periodDays = [1, 7, 30, 90, 365].includes(requestedPeriod) ? requestedPeriod : 1;
    const weekOffset = Number(c.req.query("week_offset") ?? 0) || 0;
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const limit = Math.max(1, Number(c.req.query("limit") ?? 10) || 10);
    return json(
      measureMemorySync(
        "command_center.dashboard.publication_details",
        { route: "/api/command-center/publication-details", period: periodDays, weekOffset, offset, limit },
        () =>
          renderDashboardPublicationDetails(
            config,
            backendDb,
            weekOffset,
            periodDays,
            c.req.query("view") ?? undefined,
            offset,
            limit,
            c.req.query("track") ?? undefined,
            c.req.query("video_view") ?? undefined,
            c.req.query("locale") ?? undefined,
          ),
      ),
    );
  });

  app.get("/api/ops-dashboard", (c) =>
    commandAllowed(c.req.raw, config)
      ? json(
          measureMemorySync("command_center.ops_dashboard.payload", { route: "/api/ops-dashboard" }, () => ({
            pipeline: trackUsageSync(backendDb, "command_center.pipeline.view", () => operations.pipeline()),
            ops: trackUsageSync(backendDb, "command_center.dashboard.payload", () => operations.dashboard()),
          })),
        )
      : json({ detail: "forbidden" }, 403),
  );

  app.get("/api/post-debug", (c) => {
    if (!commandAllowed(c.req.raw, config)) return json({ detail: "forbidden" }, 403);
    const ref = c.req.query("ref");
    if (!ref) return json({ detail: "missing ref" }, 400);
    const payload = trackUsageSync(backendDb, "command_center.post_debug.view", () => operations.postDebug(ref));
    return payload ? json(payload) : json({ detail: "not found" }, 404);
  });

  app.post("/api/command-center/action", async (c) => {
    const body = await commandAction(c.req.raw);
    if (!commandAllowed(c.req.raw, config, body.token)) return json({ detail: "forbidden" }, 403);
    // This endpoint deletes external publications, so it gets the same same-origin
    // check as /command-center/studio/acknowledge — cookie authority is ambient and
    // a cross-site form can ride it. A caller that presents the token explicitly is
    // a script, not a drive-by browser form, and keeps working.
    const explicitToken = Boolean(body.token?.trim() || c.req.header("X-Command-Token") || c.req.header("X-Admin-Token"));
    if (!explicitToken && !sameOriginCommandLogin(c.req.raw, config)) return json({ detail: "forbidden" }, 403);
    try {
      const result = await trackUsageAsync(backendDb, "command_center.action.execute", () => operations.command(body));
      invalidateDashboardRenderCache(backendDb);
      return json(result);
    } catch {
      return json({ detail: "Action failed" }, 400);
    }
  });
};

function dashboardMemoryContext(url: URL): Record<string, string | null> {
  return {
    route: url.pathname,
    tab: url.searchParams.get("tab") ?? "posts",
    panel: url.searchParams.get("panel") ?? "overview",
    period: url.searchParams.get("period") ?? "1",
    view: url.searchParams.get("view"),
    metric: url.searchParams.get("metric"),
  };
}

async function commandAction(request: Request): Promise<CommandAction> {
  const raw = request.headers.get("content-type")?.includes("application/json")
    ? await request.json().catch(() => ({}))
    : Object.fromEntries((await request.formData().catch(() => new FormData())).entries());
  const parsed = commandActionSchema.safeParse(raw);
  return parsed.success ? parsed.data : commandActionSchema.parse({});
}
