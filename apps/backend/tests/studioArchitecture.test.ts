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

  it("keeps the publication implementation physically inside its owning contexts", () => {
    for (const legacyArea of ["video", "site", "media"]) {
      const legacyFiles = [
        "data.ts",
        "service.ts",
        "storage.ts",
        "types.ts",
        "worker.ts",
        "publishers.ts",
        "jobs.ts",
        "prepare.ts",
        "story.ts",
      ];
      for (const file of legacyFiles)
        expect(existsSync(`${root}${legacyArea}/${file}`), `legacy ${legacyArea}/${file} should be absent`).toBe(false);
    }
  });

  it("keeps analytics and operational code in their owning contexts", () => {
    for (const legacyPath of ["metrics/index.ts", "admin/actions.ts", "ops/maintenance.ts", "services/pipeline.ts", "services/mcp.ts"])
      expect(existsSync(`${root}${legacyPath}`), `legacy ${legacyPath} should be absent`).toBe(false);
  });

  it("keeps Foundation physical and does not retain root compatibility facades", () => {
    for (const legacyPath of [
      "config.ts",
      "logger.ts",
      "scheduler.ts",
      "httpAuth.ts",
      "deployment.ts",
      "runtime/ffmpeg.ts",
      "runtime/git.ts",
      "runtime/worker-state.ts",
    ]) {
      expect(existsSync(`${root}${legacyPath}`), `legacy Foundation facade ${legacyPath} should be absent`).toBe(false);
    }
    for (const foundationPath of [
      "foundation/config.ts",
      "foundation/logger.ts",
      "foundation/scheduler.ts",
      "foundation/runtime/worker-state.ts",
    ])
      expect(existsSync(`${root}${foundationPath}`), `Foundation module ${foundationPath} should exist`).toBe(true);
  });

  it("keeps Delivery orchestration separate from platform ports without legacy facades", () => {
    const workflow = readFileSync(`${root}delivery/publish-workflow.ts`, "utf8");
    const ports = readFileSync(`${root}delivery/ports/social.ts`, "utf8");
    expect(workflow).toContain('from "./ports/social.js"');
    expect(workflow).toContain('from "./ports.js"');
    expect(ports).not.toContain('from "grammy"');
    for (const legacyPath of ["delivery/publish-cycle.ts", "delivery/publishers.ts", "delivery/social/index.ts"])
      expect(existsSync(`${root}${legacyPath}`), `legacy Delivery facade ${legacyPath} should be absent`).toBe(false);
  });

  it("does not retain technical re-export facades", () => {
    for (const legacyPath of [
      "analytics/metrics.ts",
      "analytics/collectors.ts",
      "delivery/media.ts",
      "delivery/site.ts",
      "delivery/video.ts",
      "operations/actions.ts",
      "operations/observability.ts",
      "operations/capability-report.ts",
    ])
      expect(existsSync(`${root}${legacyPath}`), `technical facade ${legacyPath} should be absent`).toBe(false);
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
    expect(service).toContain('from "../observability/health.js"');
  });

  it("keeps Content translation and Analytics collection in their owning contexts", () => {
    for (const legacyPath of [
      "translation.ts",
      "analytics/engine.ts",
      "analytics/collection.ts",
      "analytics/metrics-cycle.ts",
      "analytics/metric-schedule.ts",
      "analytics/creatorStore.ts",
      "analytics/dashboard.ts",
      "operations/pipeline.ts",
    ])
      expect(existsSync(`${root}${legacyPath}`), `legacy context entry ${legacyPath} should be absent`).toBe(false);
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
    for (const legacyPath of ["public/service.ts", "public/engagement.ts", "public/rate-limit.ts"])
      expect(existsSync(`${root}${legacyPath}`), `legacy public facade ${legacyPath} should be absent`).toBe(false);
  });

  it("keeps external publication edits inside Delivery, not Operations", () => {
    const operations = readFileSync(`${root}operations/commands.ts`, "utf8");
    const gateway = readFileSync(`${root}delivery/external-edits.ts`, "utf8");
    expect(operations).toContain('from "../delivery/external-edits.js"');
    for (const externalHost of ["api.linkedin.com", "graph.facebook.com", "editMessageText"])
      expect(operations, `Operations contains ${externalHost}`).not.toContain(externalHost);
    expect(gateway).toContain("api.linkedin.com");
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
});
