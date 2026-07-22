import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const telegramCommandAdapters = [
  "bot/post-actions.ts",
  "bot/video-actions.ts",
  "bot/video-conversation.ts",
  "bot/queue.ts",
  "bot/analytics-screen.ts",
  "bot/notifications-screen.ts",
];
const forbiddenDomainImports = [
  "../db/schema.js",
  "../publishing/queue.js",
  "../publishing/video-service.js",
  "../worker.js",
  "../delivery/",
];

describe("Studio architecture boundaries", () => {
  it("keeps Telegram command adapters out of database, worker and delivery implementations", () => {
    for (const relativePath of telegramCommandAdapters) {
      const source = readFileSync(`${root}${relativePath}`, "utf8");
      for (const forbidden of forbiddenDomainImports) expect(source, `${relativePath} imports ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("routes text-post scheduling through Studio instead of Publishing internals", () => {
    for (const relativePath of ["bot.ts", "bot/post-actions.ts"]) {
      const source = readFileSync(`${root}${relativePath}`, "utf8");
      expect(source, `${relativePath} imports Publishing directly`).not.toContain('from "../publishing/');
      expect(source, `${relativePath} imports Publishing directly`).not.toContain('from "./publishing/');
    }
  });

  it("routes video schedule parsing through Studio instead of Publishing internals", () => {
    const source = readFileSync(`${root}bot/video-conversation.ts`, "utf8");
    for (const forbidden of ["../publishing/video-data.js", "../publishing/video-service.js", "../publishing/schedule.js"])
      expect(source, `video conversation imports ${forbidden}`).not.toContain(forbidden);
    expect(source).toContain(".videos.parseSchedule(");
  });

  it("keeps HTTP controllers on the Operations and Engagement boundaries", () => {
    const source = readFileSync(`${root}api.ts`, "utf8");
    expect(source).toContain('from "./operations/service.js"');
    expect(source).toContain('from "./engagement/service.js"');
    expect(source).not.toContain('from "./operations/actions.js"');
    expect(source).not.toContain('from "./operations/command-center.js"');
    expect(source).not.toContain('from "./engagement/likes.js"');
    expect(source).not.toContain('from "./engagement/pageviews.js"');
  });

  it("keeps MCP as a Studio-services adapter rather than a database adapter", () => {
    const source = readFileSync(`${root}interfaces/mcp.ts`, "utf8");
    expect(source).toContain('from "../studio/services/index.js"');
    for (const forbidden of ["../db/schema.js", "../publishing/", "../delivery/", "../analytics/", "../worker.js", "../bot/"])
      expect(source, `MCP imports ${forbidden}`).not.toContain(`from "${forbidden}`);
  });

  it("keeps Web Studio as a Studio-services adapter rather than a database or Operations adapter", () => {
    const source = readFileSync(`${root}interfaces/web/studio.ts`, "utf8");
    expect(source).toContain('from "../../studio/services/index.js"');
    for (const forbidden of [
      "../../db/schema.js",
      "../../publishing/",
      "../../delivery/",
      "../../analytics/",
      "../../worker.js",
      "../../bot/",
      "../../operations/",
    ])
      expect(source, `Web Studio imports ${forbidden}`).not.toContain(`from "${forbidden}`);
  });

  it("keeps Command Center as an operational read model, not a delivery or interface runtime", () => {
    const source = readFileSync(`${root}operations/command-center.ts`, "utf8");
    for (const forbidden of ["../bot/", "../delivery/", "../analytics/", "../publishing/", "../worker.js", "grammy"])
      expect(source, `Command Center imports ${forbidden}`).not.toContain(forbidden);
  });

  it("keeps Content transport-neutral", () => {
    for (const relativePath of ["content/drafts.ts", "content/message.ts", "content/text.ts", "content/translation.ts"]) {
      const source = readFileSync(`${root}${relativePath}`, "utf8");
      expect(source, `${relativePath} imports Telegram`).not.toContain('from "grammy"');
      expect(source, `${relativePath} imports a Telegram adapter`).not.toContain('from "../bot/');
      expect(source, `${relativePath} imports an interface adapter`).not.toContain('from "../interfaces/');
      expect(source, `${relativePath} imports Delivery`).not.toContain('from "../delivery/');
    }
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
    ]) {
      const source = readFileSync(`${root}${relativePath}`, "utf8");
      expect(source, `${relativePath} imports Telegram`).not.toContain('from "../bot/');
      expect(source, `${relativePath} imports an interface adapter`).not.toContain('from "../interfaces/');
      expect(source, `${relativePath} imports Delivery`).not.toContain('from "../../delivery/');
      expect(source, `${relativePath} imports Studio`).not.toContain('from "../../studio/');
    }
  });

  it("keeps Delivery facades out of Telegram and Studio", () => {
    for (const relativePath of [
      "delivery/media-prepare.ts",
      "delivery/publish-workflow.ts",
      "delivery/ports/social.ts",
      "delivery/site-jobs.ts",
      "delivery/video-worker.ts",
    ]) {
      const source = readFileSync(`${root}${relativePath}`, "utf8");
      expect(source, `${relativePath} imports Telegram`).not.toContain('from "grammy"');
      expect(source, `${relativePath} imports a Telegram adapter`).not.toContain('from "../bot/');
      expect(source, `${relativePath} imports Studio`).not.toContain('from "../studio/');
      expect(source, `${relativePath} imports an interface adapter`).not.toContain('from "../interfaces/');
    }
  });

  it("keeps video delivery independent from Telegram rendering", () => {
    const source = readFileSync(`${root}delivery/video-worker.ts`, "utf8");
    for (const forbidden of ["grammy", "../interfaces/telegram/", "../studio/"])
      expect(source, `video delivery imports ${forbidden}`).not.toContain(forbidden);
  });

  it("keeps Delivery orchestration separate from platform ports without legacy facades", () => {
    const workflow = readFileSync(`${root}delivery/publish-workflow.ts`, "utf8");
    const ports = readFileSync(`${root}delivery/ports/social.ts`, "utf8");
    expect(workflow).toContain('from "./ports/social.js"');
    expect(workflow).toContain('from "./ports.js"');
    expect(ports).not.toContain('from "grammy"');
  });

  it("keeps Operations command dispatch, repairs and Observability physically separate", () => {
    const dispatcher = readFileSync(`${root}operations/commands.ts`, "utf8");
    const repair = readFileSync(`${root}operations/commands/content-repair.ts`, "utf8");
    const requeue = readFileSync(`${root}operations/commands/requeue.ts`, "utf8");
    const observability = readFileSync(`${root}observability/cycle.ts`, "utf8");
    expect(dispatcher).toContain('from "./commands/content-repair.js"');
    expect(dispatcher).toContain('from "./commands/requeue.js"');
    expect(dispatcher).not.toContain('from "drizzle-orm"');
    expect(repair).toContain('from "../../db/schema.js"');
    expect(requeue).toContain('from "../../publishing/payload.js"');
    expect(observability).toContain('from "./credentials.js"');
    expect(observability).toContain('from "./failures.js"');
    expect(observability).not.toContain('from "../bot/');
  });

  it("keeps Operations as the external diagnostics contract", () => {
    const api = readFileSync(`${root}api.ts`, "utf8");
    const cli = readFileSync(`${root}cli.ts`, "utf8");
    const service = readFileSync(`${root}operations/service.ts`, "utf8");
    expect(api).not.toContain('from "./operations/read-model.js"');
    expect(cli).not.toContain('from "./operations/read-model.js"');
    expect(service).toContain('from "./read-model.js"');
    expect(service).not.toContain('from "../observability/');
  });

  it("keeps Observability behind its own service boundary", () => {
    const workers = readFileSync(`${root}runtime/workers.ts`, "utf8");
    const service = readFileSync(`${root}observability/service.ts`, "utf8");
    expect(workers).toContain('from "../observability/service.js"');
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
    const translation = readFileSync(`${root}content/translation.ts`, "utf8");
    expect(translation).not.toContain('from "../bot/');
  });

  it("keeps Operations, Engagement and Public Site independent from interface and Studio implementations", () => {
    for (const relativePath of ["observability/cycle.ts", "operations/service.ts", "engagement/service.ts", "public/site-read-model.ts"]) {
      const source = readFileSync(`${root}${relativePath}`, "utf8");
      for (const forbidden of ["grammy", "../interfaces/", "../studio/", "../delivery/", "../bot/"])
        expect(source, `${relativePath} imports ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("keeps external publication edits inside Delivery, not Operations", () => {
    const operations = readFileSync(`${root}operations/commands.ts`, "utf8");
    const gateway = readFileSync(`${root}delivery/external-edits.ts`, "utf8");
    expect(operations).toContain('from "../delivery/external-edits.js"');
    for (const externalHost of ["graph.facebook.com", "editMessageText"])
      expect(operations, `Operations contains ${externalHost}`).not.toContain(externalHost);
    expect(gateway).toContain("graph.facebook.com");
  });

  it("keeps Operations dispatch separate from publication lookup and audit persistence", () => {
    const source = readFileSync(`${root}operations/commands.ts`, "utf8");
    expect(source).toContain('from "./action-audit.js"');
    expect(source).toContain('from "./publication-ref.js"');
    expect(source).not.toContain("function resolvePublicationRef");
    expect(source).not.toContain("function recordOperationAction");
  });

  it("keeps Video scheduling decisions in the Studio FSM", () => {
    const source = readFileSync(`${root}bot/video-conversation.ts`, "utf8");
    expect(source).toContain('from "../studio/video-fsm.js"');
    expect(source).toContain("advanceVideoTargetSchedule(");
    expect(source).toContain("commonVideoSchedule(");
  });

  it("keeps Telegram settings as a Studio command adapter", () => {
    const source = readFileSync(`${root}bot/settings-screen.ts`, "utf8");
    expect(source).toContain('from "../studio/services/index.js"');
    expect(source).not.toContain('from "../db/schema.js"');
  });

  it("keeps core workers independent from Telegram and routes UI work through durable events", () => {
    const core = readFileSync(`${root}runtime/workers.ts`, "utf8");
    const telegram = readFileSync(`${root}interfaces/telegram/worker.ts`, "utf8");
    const events = readFileSync(`${root}interfaces/telegram/event-consumer.ts`, "utf8");
    for (const forbidden of ["grammy", "../bot/", "../interfaces/"])
      expect(core, `core worker imports ${forbidden}`).not.toContain(forbidden);
    expect(telegram).toContain('from "./event-consumer.js"');
    expect(events).toContain("delivery.post.settled");
    expect(events).toContain("video.target.failed");
  });

  it("keeps publication orchestration out of the draft lifecycle", () => {
    const lifecycle = readFileSync(`${root}publishing/draft-lifecycle.ts`, "utf8");
    const workflow = readFileSync(`${root}publishing/publication-workflow.ts`, "utf8");
    expect(lifecycle).not.toContain("createPublicationPlan");
    expect(workflow).toContain("createPublicationPlan");
    expect(workflow).toContain("persistPublicationPlan");
    expect(workflow).toContain("reconcilePublication");
  });
});
