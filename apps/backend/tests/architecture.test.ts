import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

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
