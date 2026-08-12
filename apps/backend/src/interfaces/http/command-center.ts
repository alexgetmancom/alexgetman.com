import { allowPublicRequest } from "../../engagement/rate-limit.js";
import { commandAllowed, sameOriginCommandLogin } from "../../foundation/http-auth.js";
import { html, json, loginRedirect, queryTokenRedirect, text } from "../../foundation/http-response.js";
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

/** Enough for a mistyped token on a phone, far too few to search a secret. */
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_ATTEMPT_WINDOW_SECONDS = 300;

export const commandCenterRoutes: RouteModule = (app, { config, backendDb, engagement, operations, studio }) => {
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
    // The token is the only thing guarding the dashboard from the open
    // internet, and it is submitted here in a loop-friendly form post, so
    // guessing has to cost wall-clock time. Only a *failed* attempt spends
    // budget: behind a proxy that does not set the trusted client header every
    // caller hashes to one key, and counting successes there would let a
    // stranger's guessing lock the owner out of their own dashboard.
    if (typeof token !== "string" || !commandAllowed(request, config, token)) {
      const attempt = allowPublicRequest(
        `command-login:${engagement.clientKey(request)}`,
        LOGIN_ATTEMPT_LIMIT,
        LOGIN_ATTEMPT_WINDOW_SECONDS,
      );
      if (!attempt.allowed)
        return new Response("too many attempts\n", {
          status: 429,
          headers: { "content-type": "text/plain; charset=utf-8", "retry-after": String(attempt.retryAfter) },
        });
      return html(renderCommandCenterLogin(parseStudioLocale(form.get("locale")), true));
    }
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

  app.post("/api/command-center/action", async (c) => {
    const body = await commandAction(c.req.raw);
    if (!body) return json({ detail: "unreadable command" }, 400);
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

async function commandAction(request: Request): Promise<CommandAction | null> {
  const raw = request.headers.get("content-type")?.includes("application/json")
    ? await request.json().catch(() => ({}))
    : Object.fromEntries((await request.formData().catch(() => new FormData())).entries());
  const parsed = commandActionSchema.safeParse(raw);
  // A body this endpoint cannot read used to become the empty command, so a
  // misspelled field arrived as an unscoped action instead of as the error it
  // is — and a typo in `target` is the difference between one delivery target
  // and every one the publication has.
  if (!parsed.success) return null;
  // The actor is where the request arrived, never what the body claims.
  return { ...parsed.data, actor_type: "command-center" };
}
