import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { articles, drafts, publishJobs } from "../src/db/schema.js";
import { refreshPublicationOwner } from "../src/publishing/publication-owner.js";
import { withDb } from "./helpers/db.js";
import { seedTextPost } from "./helpers/post.js";

const now = "2026-08-20T10:00:00.000Z";

function articleWithJobs(backendDb: Parameters<Parameters<typeof withDb>[0]>[0], statuses: string[]): number {
  const article = backendDb.db
    .insert(articles)
    .values({ actorId: 42, status: "draft", createdAt: now, updatedAt: now })
    .returning({ id: articles.id })
    .get();
  if (!article) throw new Error("expected an article");
  for (const [index, status] of statuses.entries())
    backendDb.db
      .insert(publishJobs)
      .values({
        publicationId: article.id,
        publicationKey: `article:${article.id}`,
        target: `target_${index}`,
        status,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  return article.id;
}

function statusOf(backendDb: Parameters<Parameters<typeof withDb>[0]>[0], id: number): string | undefined {
  return backendDb.db.select({ status: articles.status }).from(articles).where(eq(articles.id, id)).get()?.status;
}

describe("publication owner refresh", () => {
  it("marks an article published once every target settled", () =>
    withDb((backendDb) => {
      const id = articleWithJobs(backendDb, ["published", "published"]);
      refreshPublicationOwner(backendDb, `article:${id}`);
      expect(statusOf(backendDb, id)).toBe("published");
    }));

  it("leaves an article alone while a target is still in flight", () =>
    withDb((backendDb) => {
      const id = articleWithJobs(backendDb, ["published", "queued"]);
      refreshPublicationOwner(backendDb, `article:${id}`);
      expect(statusOf(backendDb, id)).toBe("draft");
    }));

  it("marks an article failed when a target is awaiting verification, not published", () =>
    withDb((backendDb) => {
      const id = articleWithJobs(backendDb, ["published", "verification_required"]);
      refreshPublicationOwner(backendDb, `article:${id}`);
      expect(statusOf(backendDb, id)).toBe("failed");
    }));

  it("routes a post key to the post owner without touching articles", () =>
    withDb((backendDb) => {
      const id = articleWithJobs(backendDb, ["published"]);
      seedTextPost(backendDb, { postId: 900, status: "scheduled", now });
      backendDb.db
        .insert(publishJobs)
        .values({
          publicationId: 900,
          publicationKey: "post:900",
          target: "telegram",
          status: "published",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      refreshPublicationOwner(backendDb, "post:900");
      expect(backendDb.db.select({ status: drafts.status }).from(drafts).where(eq(drafts.postId, 900)).get()).toEqual({
        status: "published",
      });
      expect(statusOf(backendDb, id)).toBe("draft");
    }));

  it("ignores a key whose kind settles through its own workflow, and a malformed one", () =>
    withDb((backendDb) => {
      expect(() => refreshPublicationOwner(backendDb, "video:12")).not.toThrow();
      expect(() => refreshPublicationOwner(backendDb, "nonsense")).not.toThrow();
    }));
});
