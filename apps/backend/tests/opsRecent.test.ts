import { afterEach, describe, expect, it } from "bun:test";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { posts, postTargets } from "../src/db/schema.js";
import { findPublication, formatRecentPublications, recentPublications } from "../src/operations/recent.js";
import { openBackendDb } from "./helpers/open-db.js";

let backendDb: UnsafeBackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

const USUAL = ["telegram", "threads_ru", "x"];

function seed(db: UnsafeBackendDb, count: number, gap: { postId: number; target: string }): void {
  const now = new Date().toISOString();
  for (let postId = 1; postId <= count; postId += 1) {
    db.db
      .insert(posts)
      .values({
        postKey: `post:${postId}`,
        postId,
        channel: "alexgetmancom",
        messageId: postId,
        dateUtc: `2026-08-${String(postId).padStart(2, "0")}T10:00:00.000Z`,
        text: `Headline ${postId}\n\nBody copy that identifies nothing.`,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    for (const target of USUAL) {
      if (postId === gap.postId && target === gap.target) continue;
      db.db
        .insert(postTargets)
        .values({ postKey: `post:${postId}`, target, status: "published", updatedAt: now })
        .run();
    }
  }
}

describe("ops recent", () => {
  it("names the target a post is missing against its neighbours", () => {
    backendDb = openBackendDb(":memory:");
    seed(backendDb, 12, { postId: 12, target: "x" });

    const report = recentPublications(backendDb, 3);

    expect(report.expectedTargets).toEqual(USUAL);
    expect(report.posts[0]).toMatchObject({ ref: "post:12", headline: "Headline 12", missingTargets: ["x"] });
    expect(report.posts[1]?.missingTargets).toEqual([]);
    expect(report.posts).toHaveLength(3);
  });

  /** The JSON form runs to hundreds of lines, which is what sent the last
   * investigation to raw SQL instead of reading the answer off the screen. */
  it("prints two lines per post, missing target first", () => {
    backendDb = openBackendDb(":memory:");
    seed(backendDb, 12, { postId: 12, target: "x" });

    const text = formatRecentPublications(recentPublications(backendDb, 5));

    expect(text.split("\n")).toHaveLength(12);
    expect(text).toContain("MISSING x");
    expect(text).toContain("Headline 12");
    expect(text).not.toContain("https://");
  });

  it("resolves a ref from the post text", () => {
    backendDb = openBackendDb(":memory:");
    seed(backendDb, 4, { postId: 4, target: "x" });

    const found = findPublication(backendDb, "headline 2") as { matches: Array<{ ref: string }> };

    expect(found.matches.map((match) => match.ref)).toEqual(["post:2"]);
  });
});
