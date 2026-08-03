import { afterEach, describe, expect, it } from "bun:test";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { posts, postTargets } from "../src/db/schema.js";
import { verifyPostTargets } from "../src/operations/verify.js";
import { withDb } from "./helpers/db.js";

const now = "2026-07-27T10:00:00.000Z";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** verifyPostTargets reaches for the global fetch, so a stub has to replace it
 * rather than be passed in; no-network.ts throws on anything left unstubbed. */
function stubFetch(handler: (url: string) => Response | Promise<Response>): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      return handler(url);
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
  return { urls };
}

function insertPost(backendDb: UnsafeBackendDb, overrides: { postKey: string; postId?: number | null; messageId: number }): void {
  backendDb.db
    .insert(posts)
    .values({
      postKey: overrides.postKey,
      postId: overrides.postId ?? null,
      channel: "alexgetman",
      messageId: overrides.messageId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function insertTarget(
  backendDb: UnsafeBackendDb,
  values: { postKey: string; target: string; status: string; url?: string | null; error?: string | null },
): void {
  backendDb.db
    .insert(postTargets)
    .values({
      postKey: values.postKey,
      target: values.target,
      status: values.status,
      url: values.url ?? null,
      error: values.error ?? null,
      updatedAt: now,
    })
    .run();
}

describe("verifyPostTargets", () => {
  it("resolves a post:<id> ref and reports a live publication as ok", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postKey: "post:106", postId: 106, messageId: 106 });
      insertTarget(backendDb, { postKey: "post:106", target: "telegram", status: "published", url: "https://t.me/alexgetman/106" });
      const { urls } = stubFetch(() => new Response("ok", { status: 200 }));

      expect(await verifyPostTargets(backendDb, "post:106")).toEqual([
        {
          target: "telegram",
          status: "published",
          url: "https://t.me/alexgetman/106",
          error: null,
          ok: true,
          reason: "http_200",
        },
      ]);
      expect(urls).toEqual(["https://t.me/alexgetman/106"]);
    });
  });

  it("resolves the same post by messageId when the key does not match", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postKey: "studio:abc", postId: null, messageId: 106 });
      insertTarget(backendDb, { postKey: "studio:abc", target: "telegram", status: "queued" });

      expect(await verifyPostTargets(backendDb, "post:106")).toMatchObject([{ ok: false, reason: "not_published" }]);
    });
  });

  it("throws for an unknown ref instead of returning an empty verdict", async () => {
    await withDb(async (backendDb) => {
      await expect(verifyPostTargets(backendDb, "post:999")).rejects.toThrow("post not found: post:999");
    });
  });

  it("matches a non-numeric ref on the post key alone, without binding NaN", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postKey: "post:draft-abc", postId: 7, messageId: 7 });
      insertTarget(backendDb, { postKey: "post:draft-abc", target: "site", status: "published" });

      expect(await verifyPostTargets(backendDb, "post:draft-abc")).toMatchObject([{ ok: true, reason: "no_public_url_known" }]);
      await expect(verifyPostTargets(backendDb, "post:nope")).rejects.toThrow("post not found");
    });
  });

  it("counts 404 and 410 as failures, so a deleted publication does not verify as ok", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postKey: "post:1", postId: 1, messageId: 1 });
      insertTarget(backendDb, { postKey: "post:1", target: "instagram", status: "published", url: "https://example.test/gone" });
      insertTarget(backendDb, { postKey: "post:1", target: "threads", status: "published", url: "https://example.test/deleted" });
      stubFetch((url) => new Response(null, { status: url.endsWith("/gone") ? 404 : 410 }));

      expect(await verifyPostTargets(backendDb, "post:1")).toMatchObject([
        { target: "instagram", ok: false, reason: "http_404" },
        { target: "threads", ok: false, reason: "http_410" },
      ]);
    });
  });

  it("treats a provider 5xx as a failure too", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postKey: "post:2", postId: 2, messageId: 2 });
      insertTarget(backendDb, { postKey: "post:2", target: "x", status: "published", url: "https://example.test/down" });
      stubFetch(() => new Response(null, { status: 503 }));

      expect(await verifyPostTargets(backendDb, "post:2")).toMatchObject([{ ok: false, reason: "http_503" }]);
    });
  });

  it("surfaces a transport error as the reason rather than throwing", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postKey: "post:3", postId: 3, messageId: 3 });
      insertTarget(backendDb, { postKey: "post:3", target: "x", status: "published", url: "https://example.test/unreachable" });
      stubFetch(() => {
        throw new Error("connect ECONNREFUSED");
      });

      expect(await verifyPostTargets(backendDb, "post:3")).toMatchObject([{ ok: false, reason: "connect ECONNREFUSED" }]);
    });
  });

  it("prefers the stored error over the generic reason for an unpublished target", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postKey: "post:4", postId: 4, messageId: 4 });
      insertTarget(backendDb, { postKey: "post:4", target: "x", status: "failed", error: "rate limited" });

      expect(await verifyPostTargets(backendDb, "post:4")).toMatchObject([{ ok: false, reason: "rate limited" }]);
    });
  });

  it("never calls out for a target that is not published", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postKey: "post:5", postId: 5, messageId: 5 });
      insertTarget(backendDb, { postKey: "post:5", target: "x", status: "queued", url: "https://example.test/not-yet" });
      const { urls } = stubFetch(() => new Response("ok", { status: 200 }));

      expect(await verifyPostTargets(backendDb, "post:5")).toMatchObject([{ ok: false, reason: "not_published" }]);
      expect(urls).toEqual([]);
    });
  });

  it("returns targets ordered by name and ignores other posts' targets", async () => {
    await withDb(async (backendDb) => {
      insertPost(backendDb, { postKey: "post:6", postId: 6, messageId: 6 });
      insertPost(backendDb, { postKey: "post:7", postId: 7, messageId: 7 });
      for (const target of ["telegram", "instagram", "x"]) {
        insertTarget(backendDb, { postKey: "post:6", target, status: "queued" });
      }
      insertTarget(backendDb, { postKey: "post:7", target: "site", status: "queued" });

      expect((await verifyPostTargets(backendDb, "post:6")).map((record) => record.target)).toEqual(["instagram", "telegram", "x"]);
    });
  });
});
