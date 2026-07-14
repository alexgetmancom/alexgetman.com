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

  it("keeps HTTP controllers on the Operations and Studio boundaries", () => {
    const source = readFileSync(`${root}api.ts`, "utf8");
    expect(source).toContain('from "./operations/service.js"');
    expect(source).not.toContain('from "./operations/actions.js"');
    expect(source).not.toContain('from "./operations/command-center.js"');
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
    for (const relativePath of ["content/drafts.ts", "content/message.ts", "content/text.ts"]) {
      const source = readFileSync(`${root}${relativePath}`, "utf8");
      expect(source, `${relativePath} imports Telegram`).not.toContain('from "grammy"');
      expect(source, `${relativePath} imports a Telegram adapter`).not.toContain('from "../bot/');
      expect(source, `${relativePath} imports an interface adapter`).not.toContain('from "../interfaces/');
    }
  });

  it("keeps Analytics transport-neutral", () => {
    for (const relativePath of [
      "analytics/engine.ts",
      "analytics/dashboard.ts",
      "analytics/studioDashboard.ts",
      "analytics/postArchive.ts",
      "analytics/videoArchive.ts",
      "analytics/audience.ts",
    ]) {
      const source = readFileSync(`${root}${relativePath}`, "utf8");
      expect(source, `${relativePath} imports Telegram`).not.toContain('from "../bot/');
      expect(source, `${relativePath} imports an interface adapter`).not.toContain('from "../interfaces/');
    }
  });

  it("keeps Delivery facades out of Telegram and Studio", () => {
    for (const relativePath of [
      "delivery/media.ts",
      "delivery/publish-cycle.ts",
      "delivery/publishers.ts",
      "delivery/site.ts",
      "delivery/video.ts",
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
});
