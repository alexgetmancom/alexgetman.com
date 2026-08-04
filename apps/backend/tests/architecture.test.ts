import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function sourceFiles(relativeDirectory: string): string[] {
  return readdirSync(join(root, relativeDirectory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relativePath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [relativePath] : [];
  });
}

/** Keep exceptions explicit and shrinking. New application files are covered automatically. */
const applicationPersistenceExceptions = new Set<string>();

describe("architecture fitness", () => {
  it("keeps one public entry point for each application boundary", () => {
    const entryPoints = [
      "apps/backend/src/application/index.ts",
      "apps/backend/src/content/index.ts",
      "apps/backend/src/publishing/index.ts",
      "apps/backend/src/delivery/index.ts",
      "apps/backend/src/operations/index.ts",
      "apps/backend/src/studio/services/index.ts",
    ];

    for (const entryPoint of entryPoints) expect(existsSync(join(root, entryPoint))).toBe(true);
  });

  it("keeps application ports and domain event policy independent from infrastructure", () => {
    for (const file of [
      "apps/backend/src/application/ports.ts",
      "apps/backend/src/domain/events.ts",
      "apps/backend/src/content/drafts.ts",
    ]) {
      const text = source(file);
      expect(text).not.toMatch(/from ["'][^"']*\/db\//);
      expect(text).not.toMatch(/from ["']drizzle-orm/);
    }
    for (const file of ["apps/backend/src/studio/services/posts.ts", "apps/backend/src/studio/services/post-queries.ts"]) {
      const text = source(file);
      expect(text).not.toMatch(/from ["'][^"']*\/db\/schema/);
      expect(text).not.toMatch(/from ["']drizzle-orm/);
    }
  });

  it("keeps Studio and content application services behind persistence ports", () => {
    const files = ["apps/backend/src/studio", "apps/backend/src/content"].flatMap(sourceFiles);
    for (const file of files) {
      if (applicationPersistenceExceptions.has(file)) continue;
      const text = source(file);
      expect(text).not.toContain("backendDb.db");
      expect(text).not.toContain("backendDb.sqlite");
      expect(text).not.toContain("unsafeDb(");
      expect(text).not.toMatch(/from ["'][^"']*\/db\/schema/);
      expect(text).not.toMatch(/from ["']drizzle-orm/);
    }
  });

  it("keeps Telegram conversation state behind one persistence port", () => {
    for (const file of ["apps/backend/src/bot/post-state.ts", "apps/backend/src/bot/video-session.ts"]) {
      const text = source(file);
      expect(text).not.toContain("unsafeDb(");
      expect(text).not.toMatch(/from ["'][^"']*\/db\/schema/);
      expect(text).toContain("conversationSessions");
    }
  });

  it("routes domain events through the durable event port", () => {
    const events = source("apps/backend/src/domain/events.ts");
    expect(events).toContain("events: EventStore");
    expect(events).toContain("return events.record(input)");

    const producerFiles = [
      "apps/backend/src/content/assets.ts",
      "apps/backend/src/content/drafts.ts",
      "apps/backend/src/delivery/publish-workflow.ts",
      "apps/backend/src/delivery/video-worker.ts",
      "apps/backend/src/publishing/publication-workflow.ts",
      "apps/backend/src/studio/services/posts.ts",
      "apps/backend/src/studio/services/videos.ts",
    ];
    for (const file of producerFiles) expect(source(file)).not.toMatch(/recordDomainEvent\(backendDb,/);
  });

  it("keeps infrastructure adapters behind the composition root", () => {
    const client = source("apps/backend/src/db/client.ts");
    expect(client).toContain("createDraftStore(db, clock)");
    expect(client).toContain("createEventStore(db, clock)");
    expect(client).toContain("storyCards: { queue:");
  });
});
