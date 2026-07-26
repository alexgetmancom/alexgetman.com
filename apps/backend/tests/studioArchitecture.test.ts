import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/", import.meta.url));

/** Boundary assertions must not be tripped by a module path that only appears in
 * prose, so comments and string bodies are removed before anything is matched. */
function sourceOf(relativePath: string): string {
  return readFileSync(`${root}${relativePath}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Module specifiers of every static and dynamic import, so a rule about
 * dependencies cannot be satisfied or broken by unrelated text. */
function importsOf(relativePath: string): string[] {
  const source = sourceOf(relativePath);
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) if (match[1]) specifiers.push(match[1]);
  return specifiers;
}

/** Resolve a specifier to a path relative to src/, so that rules are written
 * against the layer being forbidden and not against how many `../` hops the
 * importing file happens to sit behind it.
 *
 * The earlier version compared raw specifiers, which made every rule silently
 * depth-sensitive: `analytics/reports/dashboard.ts` imports
 * `../../interfaces/telegram/...`, so a rule forbidding `../interfaces/` matched
 * nothing and passed while the boundary was in fact broken. Package specifiers
 * (`grammy`, `drizzle-orm`) have no `.` prefix and are returned unchanged. */
function resolveSpecifier(fromPath: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const segments = `${posix.dirname(fromPath)}/${specifier}`.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join("/");
}

/** `forbidden` is src-relative: "interfaces/", "db/schema.js", or a bare package
 * name such as "grammy". A trailing slash forbids a whole subtree. */
function expectNoImport(relativePath: string, forbidden: string): void {
  const offending = importsOf(relativePath)
    .map((specifier) => resolveSpecifier(relativePath, specifier))
    .filter((resolved) => resolved === forbidden || resolved.startsWith(forbidden));
  expect(offending, `${relativePath} imports ${forbidden}`).toEqual([]);
}

function expectImport(relativePath: string, expected: string): void {
  const resolved = importsOf(relativePath).map((specifier) => resolveSpecifier(relativePath, specifier));
  expect(resolved, `${relativePath} should import ${expected}`).toContain(expected);
}

/** Telegram screens, command handlers and conversations, discovered by naming
 * convention rather than listed, so a newly added adapter is covered the moment
 * it lands. Rendering helpers (albums, previews, i18n, session state) are not
 * adapters and keep their own dependencies. */
const telegramCommandAdapters = readdirSync(`${root}bot`)
  .filter((name) => /-(screen|actions|conversation)\.ts$/.test(name) || name === "queue.ts")
  .map((name) => `bot/${name}`);
const forbiddenDomainImports = ["db/schema.js", "publishing/queue.js", "publishing/video-service.js", "worker.js", "delivery/"];

describe("Studio architecture boundaries", () => {
  it("keeps Telegram command adapters out of database, worker and delivery implementations", () => {
    for (const relativePath of telegramCommandAdapters)
      for (const forbidden of forbiddenDomainImports) expectNoImport(relativePath, forbidden);
  });

  it("routes text-post scheduling through Studio instead of Publishing internals", () => {
    for (const relativePath of ["bot.ts", "bot/post-actions.ts"]) {
      expectNoImport(relativePath, "publishing/");
    }
  });

  it("routes video schedule parsing through Studio instead of Publishing internals", () => {
    for (const forbidden of ["publishing/video-data.js", "publishing/video-service.js", "publishing/schedule.js"])
      expectNoImport("bot/video-conversation.ts", forbidden);
    expect(sourceOf("bot/video-conversation.ts")).toContain(".videos.parseSchedule(");
  });

  it("keeps HTTP controllers on the Operations and Engagement boundaries", () => {
    expectImport("api.ts", "operations/service.js");
    expectImport("api.ts", "engagement/service.js");
    for (const forbidden of ["operations/actions.js", "operations/command-center.js", "engagement/likes.js", "engagement/pageviews.js"])
      expectNoImport("api.ts", forbidden);
  });

  it("keeps MCP as a Studio-services adapter rather than a database adapter", () => {
    expectImport("interfaces/mcp.ts", "studio/services/index.js");
    for (const forbidden of ["db/schema.js", "publishing/", "delivery/", "analytics/", "worker.js", "bot/"])
      expectNoImport("interfaces/mcp.ts", forbidden);
  });

  it("keeps Web Studio as a Studio-services adapter rather than a database or Operations adapter", () => {
    expectImport("interfaces/web/studio.ts", "studio/services/index.js");
    for (const forbidden of ["db/schema.js", "publishing/", "delivery/", "analytics/", "worker.js", "bot/", "operations/"])
      expectNoImport("interfaces/web/studio.ts", forbidden);
  });

  it("keeps Command Center as an operational read model, not a delivery or interface runtime", () => {
    for (const forbidden of ["bot/", "delivery/", "analytics/", "publishing/", "worker.js", "grammy"])
      expectNoImport("operations/command-center.ts", forbidden);
  });

  it("keeps Content transport-neutral", () => {
    for (const relativePath of ["content/drafts.ts", "content/message.ts", "content/text.ts", "content/translation.ts"])
      for (const forbidden of ["grammy", "bot/", "interfaces/", "delivery/"]) expectNoImport(relativePath, forbidden);
  });

  it("keeps Analytics transport-neutral", () => {
    for (const relativePath of [
      "analytics/collection/creator-cycle.ts",
      "analytics/collection/metrics-cycle.ts",
      "analytics/reports/dashboard.ts",
      "analytics/reports/studio-dashboard.ts",
      "analytics/reports/post-archive.ts",
      "analytics/reports/video-archive.ts",
      "analytics/reports/audience.ts",
    ])
      for (const forbidden of ["bot/", "interfaces/", "delivery/", "studio/"]) expectNoImport(relativePath, forbidden);
  });

  it("keeps Delivery facades out of Telegram and Studio", () => {
    for (const relativePath of [
      "delivery/media-prepare.ts",
      "delivery/publish-workflow.ts",
      "delivery/ports/social.ts",
      "delivery/site-jobs.ts",
      "delivery/video-worker.ts",
    ])
      for (const forbidden of ["grammy", "bot/", "studio/", "interfaces/"]) expectNoImport(relativePath, forbidden);
  });

  it("keeps video delivery independent from Telegram rendering", () => {
    for (const forbidden of ["grammy", "interfaces/telegram/", "studio/"]) expectNoImport("delivery/video-worker.ts", forbidden);
  });

  it("keeps Delivery orchestration separate from platform ports without legacy facades", () => {
    expectImport("delivery/publish-workflow.ts", "delivery/ports/social.js");
    expectImport("delivery/publish-workflow.ts", "delivery/ports.js");
    expectNoImport("delivery/ports/social.ts", "grammy");
  });

  it("keeps Operations command dispatch, repairs and Observability physically separate", () => {
    expectImport("operations/commands.ts", "operations/commands/content-repair.js");
    expectImport("operations/commands.ts", "operations/commands/requeue.js");
    expectNoImport("operations/commands.ts", "drizzle-orm");
    expectImport("operations/commands/content-repair.ts", "db/schema.js");
    expectImport("operations/commands/requeue.ts", "publishing/payload.js");
    expectImport("observability/cycle.ts", "observability/credentials.js");
    expectImport("observability/cycle.ts", "observability/failures.js");
    expectNoImport("observability/cycle.ts", "bot/");
  });

  it("keeps Operations as the external diagnostics contract", () => {
    expectNoImport("api.ts", "operations/read-model.js");
    expectNoImport("cli.ts", "operations/read-model.js");
    expectImport("operations/service.ts", "operations/read-model.js");
    expectNoImport("operations/service.ts", "observability/");
  });

  it("keeps Observability behind its own service boundary", () => {
    expectImport("runtime/workers.ts", "observability/service.js");
    const service = sourceOf("observability/service.ts");
    expect(service).toContain("healthReport");
    expect(service).toContain("runObservabilityCycle");
  });

  it("keeps Content translation and Analytics collection in their owning contexts", () => {
    expect(existsSync(`${root}content/translation.ts`)).toBe(true);
    for (const analyticsPath of [
      "analytics/collection/creator-cycle.ts",
      "analytics/collection/metrics-cycle.ts",
      "analytics/snapshots/creator-store.ts",
      "analytics/reports/dashboard.ts",
    ])
      expect(existsSync(`${root}${analyticsPath}`), `Analytics module ${analyticsPath} should exist`).toBe(true);
    expectNoImport("content/translation.ts", "bot/");
  });

  it("keeps Operations, Engagement and Public Site independent from interface and Studio implementations", () => {
    for (const relativePath of ["observability/cycle.ts", "operations/service.ts", "engagement/service.ts", "public/site-read-model.ts"])
      for (const forbidden of ["grammy", "interfaces/", "studio/", "delivery/", "bot/"]) expectNoImport(relativePath, forbidden);
  });

  it("keeps external publication edits inside Delivery, not Operations", () => {
    expectImport("operations/commands.ts", "delivery/external-edits.js");
    expect(sourceOf("operations/commands.ts"), "Operations calls a Telegram edit API directly").not.toContain("editMessageText");
    expect(sourceOf("delivery/external-edits.ts")).toContain("editMessageCaption");
  });

  it("keeps Operations dispatch separate from publication lookup and audit persistence", () => {
    expectImport("operations/commands.ts", "operations/action-audit.js");
    expectImport("operations/commands.ts", "operations/publication-ref.js");
    const source = sourceOf("operations/commands.ts");
    expect(source).not.toContain("function resolvePublicationRef");
    expect(source).not.toContain("function recordOperationAction");
  });

  it("keeps Video scheduling decisions in the Studio FSM", () => {
    expectImport("bot/video-conversation.ts", "studio/video-fsm.js");
    const source = sourceOf("bot/video-conversation.ts");
    expect(source).toContain("advanceVideoTargetSchedule(");
    expect(source).toContain("commonVideoSchedule(");
  });

  it("keeps Telegram settings as a Studio command adapter", () => {
    expectImport("bot/settings-screen.ts", "studio/services/index.js");
    expectNoImport("bot/settings-screen.ts", "db/schema.js");
  });

  it("keeps core workers independent from Telegram and routes UI work through durable events", () => {
    for (const forbidden of ["grammy", "bot/", "interfaces/"]) expectNoImport("runtime/workers.ts", forbidden);
    expectImport("interfaces/telegram/worker.ts", "interfaces/telegram/event-consumer.js");
    const events = sourceOf("interfaces/telegram/event-consumer.ts");
    expect(events).toContain("delivery.post.settled");
    expect(events).toContain("video.target.failed");
  });

  it("keeps publication orchestration out of the draft lifecycle", () => {
    expect(sourceOf("publishing/draft-lifecycle.ts")).not.toContain("createPublicationPlan");
    const workflow = sourceOf("publishing/publication-workflow.ts");
    expect(workflow).toContain("createPublicationPlan");
    expect(workflow).toContain("persistPublicationPlan");
    expect(workflow).toContain("reconcilePublication");
  });
});
