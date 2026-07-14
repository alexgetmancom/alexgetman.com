import { describe, expect, it } from "bun:test";
import { asc, count, eq } from "drizzle-orm";
import { openBackendDb } from "../src/db/client.js";
import { posts, postTargets, publicationSources, publications, publishJobs, siteSourceItems } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { runCommandAction } from "../src/operations/actions.js";
import { enqueuePublishJob } from "../src/publishing/queue.js";

describe("command center actions", () => {
  it("rebuilds retried jobs from the source using the target locale", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      const source = {
        text: "Русский текст",
        text_ru: "Русский текст",
        text_en: "English text",
        media: [{ file_id: "ru-photo" }],
        media_en: [{ file_id: "en-photo" }],
        slug_ru: "russian",
        slug_en: "english",
      };
      backendDb.db
        .insert(publications)
        .values({
          postId: 52,
          status: "published",
          telegramMessageId: 492,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(publicationSources)
        .values({
          postId: 52,
          itemJson: source,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      for (const target of ["threads_ru", "threads_en"]) {
        const id = enqueuePublishJob(backendDb, {
          postId: 52,
          postKey: "post:52",
          messageId: 52,
          target,
          payload: source,
        });
        backendDb.db.update(publishJobs).set({ status: "failed" }).where(eq(publishJobs.jobId, id)).run();
        await runCommandAction(backendDb, {
          action: "retry",
          ref: "post:52",
          target,
        });
      }

      const jobs = backendDb.db
        .select({
          target: publishJobs.target,
          payloadJson: publishJobs.payloadJson,
        })
        .from(publishJobs)
        .where(eq(publishJobs.postId, 52))
        .orderBy(asc(publishJobs.target))
        .all();
      const payloads = Object.fromEntries(jobs.map((job) => [job.target, job.payloadJson ?? {}]));
      expect(payloads.threads_ru).toMatchObject({
        locale: "ru",
        text: "Русский текст",
        text_en: "",
        media: [{ file_id: "ru-photo" }],
      });
      expect(payloads.threads_en).toMatchObject({
        locale: "en",
        text: "English text",
        text_en: "English text",
        media: [{ file_id: "en-photo" }],
      });
      expect(backendDb.db.select({ count: count() }).from(publishJobs).where(eq(publishJobs.postId, 52)).get()?.count).toBe(2);
    } finally {
      backendDb.close();
    }
  });

  it("requeues a missing target job for a legacy Telegram post", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(posts)
        .values({
          postKey: "telegram:alexgetmancom:777",
          channel: "alexgetmancom",
          messageId: 777,
          text: "Русский",
          textEn: "English",
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(siteSourceItems)
        .values({
          messageId: 777,
          itemJson: {
            text_ru: "Русский",
            text_en: "English",
            media: [{ file_id: "ru" }],
            media_en: [{ file_id: "en" }],
          },
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const result = await runCommandAction(backendDb, {
        action: "retry",
        ref: "777",
        target: "threads_en",
      });
      expect(result).toMatchObject({
        ok: true,
        post_key: "telegram:alexgetmancom:777",
        targets: ["threads_en"],
      });
      expect(backendDb.db.select().from(publishJobs).where(eq(publishJobs.target, "threads_en")).get()?.payloadJson).toMatchObject({
        locale: "en",
        text: "English",
        media: [{ file_id: "en" }],
      });
    } finally {
      backendDb.close();
    }
  });

  it("edits published external targets as a best-effort side effect", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(publications)
        .values({
          postId: 7,
          status: "published",
          telegramMessageId: 707,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(posts)
        .values({
          postKey: "post:7",
          postId: 7,
          channel: "controller",
          chatId: "-1001",
          messageId: 707,
          text: "RU",
          textEn: "EN",
          status: "active",
          mediaCount: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(postTargets)
        .values({
          postKey: "post:7",
          target: "linkedin",
          status: "published",
          externalId: "urn:li:share:7",
          updatedAt: now,
        })
        .run();
      const calls: string[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response("", { status: 204 });
      }) as typeof fetch;
      const result = await runCommandAction(
        backendDb,
        { action: "edit_en", ref: "post:7", text_en: "Updated EN" },
        loadConfig({
          LINKEDIN_ACCESS_TOKEN: "token",
          LINKEDIN_API_VERSION: "202606",
          TELEGRAM_API_BASE_URL: "https://api.telegram.org",
          CHANNEL_USERNAME: "alexgetmancom",
        }),
        fetchImpl,
      );
      expect(result.external).toEqual([{ target: "linkedin", ok: true, status: 204, response: null }]);
      expect(calls).toEqual(["https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A7"]);
    } finally {
      backendDb.close();
    }
  });

  it("uses the Facebook token and reports a missing token without a network call", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db.insert(publications).values({ postId: 8, status: "published", createdAt: now, updatedAt: now }).run();
      backendDb.db
        .insert(posts)
        .values({
          postKey: "post:8",
          postId: 8,
          channel: "controller",
          messageId: 8,
          text: "RU",
          textEn: "EN",
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(postTargets)
        .values([{ postKey: "post:8", target: "facebook", status: "published", externalId: "en-post", updatedAt: now }])
        .run();
      const requests: Array<{ url: string; body: string }> = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const result = await runCommandAction(
        backendDb,
        { action: "edit_en", ref: "post:8", text_en: "Updated EN" },
        loadConfig({ FACEBOOK_PAGE_ACCESS_TOKEN: "en-token" }),
        fetchImpl,
      );

      expect(requests).toEqual([
        {
          url: "https://graph.facebook.com/v23.0/en-post",
          body: JSON.stringify({ message: "Updated EN", description: "Updated EN", access_token: "en-token" }),
        },
      ]);
      expect(result.external).toEqual([{ target: "facebook", ok: true, status: 200, response: {} }]);
      const missingToken = await runCommandAction(
        backendDb,
        { action: "edit_en", ref: "post:8", text_en: "No token" },
        loadConfig({}),
        fetchImpl,
      );
      expect(missingToken.external).toEqual([
        { target: "facebook", ok: false, skipped: true, error: "missing FACEBOOK_PAGE_ACCESS_TOKEN" },
      ]);
      expect(requests).toHaveLength(1);
    } finally {
      backendDb.close();
    }
  });
});
