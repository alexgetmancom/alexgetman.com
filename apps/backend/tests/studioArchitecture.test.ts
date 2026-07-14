import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
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
const forbiddenDomainImports = ["../db/schema.js", "../publishing/queue.js", "../video/service.js", "../worker.js", "../delivery/"];

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

  it("keeps MCP as a Studio-services adapter rather than a database adapter", () => {
    const source = readFileSync(`${root}services/mcp.ts`, "utf8");
    expect(source).toContain('from "../studio/services/index.js"');
    for (const forbidden of ["../db/schema.js", "../publishing/", "../delivery/", "../analytics/", "../worker.js", "../bot/"])
      expect(source, `MCP imports ${forbidden}`).not.toContain(`from "${forbidden}`);
  });

  it("keeps Command Center as an operational read model, not a delivery or interface runtime", () => {
    const source = readFileSync(`${root}admin/commandCenter.ts`, "utf8");
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
});
