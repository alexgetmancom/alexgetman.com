import { describe, expect, it } from "bun:test";
import { asc, count, eq } from "drizzle-orm";
import { posts, postTargets, publicationSources, publications, publishJobs, siteJobs, siteSourceItems } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { runOperationCommand } from "../src/operations/commands.js";
import { enqueuePublishJobTx } from "../src/publishing/queue.js";
import { postService } from "../src/studio/services/posts.js";
import { openBackendDb } from "./helpers/open-db.js";

describe("command center actions", () => {
  it("rebuilds retried jobs from the source using the target locale", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      const source = {
        text: "Русский текст",
        text_ru: "Русский текст",
        text_en: "English text",
        media: [{ type: "photo", file_id: "ru-photo" }],
        media_en: [{ type: "photo", file_id: "en-photo" }],
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
        const id = enqueuePublishJobTx(backendDb.db, {
          postId: 52,
          postKey: "post:52",
          messageId: 52,
          target,
          payload: source,
        });
        backendDb.db.update(publishJobs).set({ status: "failed" }).where(eq(publishJobs.jobId, id)).run();
        await runOperationCommand(backendDb, {
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
        media: [{ type: "IMAGE", fileId: "ru-photo" }],
      });
      expect(payloads.threads_en).toMatchObject({
        locale: "en",
        text: "English text",
        text_en: "English text",
        media: [{ type: "IMAGE", fileId: "en-photo" }],
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
            media: [{ type: "photo", file_id: "ru" }],
            media_en: [{ type: "photo", file_id: "en" }],
          },
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const result = await runOperationCommand(backendDb, {
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
        media: [{ type: "IMAGE", fileId: "en" }],
      });
    } finally {
      backendDb.close();
    }
  });

  it("does not edit unsupported English targets", async () => {
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
        .values([{ postKey: "post:8", target: "threads_en", status: "published", externalId: "en-post", updatedAt: now }])
        .run();
      const requests: Array<{ url: string; body: string }> = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const result = await runOperationCommand(
        backendDb,
        { action: "edit_en", ref: "post:8", text_en: "Updated EN" },
        loadConfig({}),
        fetchImpl,
      );

      expect(requests).toEqual([]);
      // Reported as an explicit skip, not silence: the caller must be able to
      // tell "there is no edit port for this platform" from "the edit landed".
      expect(result.external).toEqual([{ target: "threads_en", ok: false, skipped: true, error: "no_edit_port_for_target" }]);
    } finally {
      backendDb.close();
    }
  });

  it("deletes a selected locale target and queues its replacement", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      const source = { text_ru: "RU", text_en: "EN", media: [], media_en: [] };
      backendDb.db.insert(publications).values({ postId: 9, status: "published", createdAt: now, updatedAt: now }).run();
      backendDb.db
        .insert(posts)
        .values({
          postKey: "post:9",
          postId: 9,
          channel: "studio",
          messageId: 9,
          text: "RU",
          textEn: "EN",
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db.insert(publicationSources).values({ postId: 9, itemJson: source, createdAt: now, updatedAt: now }).run();
      const jobId = enqueuePublishJobTx(backendDb.db, {
        postId: 9,
        postKey: "post:9",
        messageId: 9,
        target: "threads_en",
        payload: source,
      });
      backendDb.db.update(publishJobs).set({ status: "published" }).where(eq(publishJobs.jobId, jobId)).run();
      backendDb.db
        .insert(postTargets)
        .values({ postKey: "post:9", target: "threads_en", status: "published", externalId: "page_post", updatedAt: now })
        .run();
      const requests: Array<{ url: string; method: string }> = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), method: init?.method ?? "GET" });
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      const result = await runOperationCommand(
        backendDb,
        { action: "delete_republish", ref: "post:9", locale: "en" },
        loadConfig({ THREADS_EN_ACCESS_TOKEN: "token" }),
        fetchImpl,
      );
      expect(requests).toEqual([{ url: "https://graph.threads.net/v1.0/page_post?access_token=token", method: "DELETE" }]);
      expect(result.removed).toEqual([{ target: "threads_en", ok: true, deleted: 1 }]);
      expect(backendDb.db.select().from(postTargets).where(eq(postTargets.target, "threads_en")).get()?.status).toBe("queued");
    } finally {
      backendDb.close();
    }
  });

  it("refreshes only the requested site locale without queuing social targets", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db.insert(publications).values({ postId: 10, status: "published", createdAt: now, updatedAt: now }).run();
      const result = await runOperationCommand(backendDb, { action: "refresh_site", ref: "post:10", locale: "en" });
      expect(result).toMatchObject({ ok: true, post_id: 10, locale: "en", site_refresh: true });
      await runOperationCommand(backendDb, { action: "refresh_site", ref: "post:10", locale: "en" });
      expect(backendDb.db.select().from(siteJobs).get()).toMatchObject({ postId: 10, reason: "refresh_en_site", status: "queued" });
      expect(backendDb.db.select({ count: count() }).from(siteJobs).get()?.count).toBe(1);
      expect(backendDb.db.select().from(publishJobs).all()).toHaveLength(0);
    } finally {
      backendDb.close();
    }
  });

  it("reschedules a Studio post by locale through the operations command", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ ADMIN_IDS: "42" });
      const posts = postService(backendDb, config);
      const draftId = posts.create(42, { text: "RU", textEn: "EN", entities: [], media: [] });
      const initialAt = new Date(Date.now() + 60 * 60_000);
      const postId = posts.schedule(42, draftId, { ruAt: initialAt, enAt: initialAt });
      const nextAt = new Date(Date.now() + 2 * 60 * 60_000);

      const result = await runOperationCommand(
        backendDb,
        { action: "reschedule", ref: `post:${postId}`, schedule_locale: "ru", at: nextAt.toISOString() },
        config,
      );

      expect(result).toMatchObject({ ok: true, action: "reschedule", draft_id: draftId, post_id: postId, locale: "ru" });
      expect(result.ru_at).toBe(nextAt.toISOString());
      expect(result.en_at).toBe(initialAt.toISOString());
    } finally {
      backendDb.close();
    }
  });
  it("refuses to requeue a target a worker is still publishing", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db.insert(publications).values({ postId: 61, status: "published", createdAt: now, updatedAt: now }).run();
      backendDb.db
        .insert(publicationSources)
        .values({ postId: 61, itemJson: { text: "RU", text_en: "EN" }, createdAt: now, updatedAt: now })
        .run();
      const jobId = enqueuePublishJobTx(backendDb.db, {
        postId: 61,
        postKey: "post:61",
        messageId: 61,
        target: "threads_en",
        payload: { text: "RU", text_en: "EN" },
      });
      // Mid-flight: a worker holds the lock and has already reached the provider.
      backendDb.db
        .update(publishJobs)
        .set({ status: "publishing", lockedBy: "worker-1", lockedAt: now, currentPhase: "provider.publish" })
        .where(eq(publishJobs.jobId, jobId))
        .run();

      const result = await runOperationCommand(backendDb, { action: "retry", ref: "post:61", target: "threads_en" });

      expect(result).toMatchObject({ ok: false, results: [{ target: "threads_en", outcome: "publishing" }] });
      // Untouched: stealing the lock would make the worker discard a publication
      // that already went out, and the next claim would send it again.
      const job = backendDb.db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get();
      expect(job).toMatchObject({ status: "publishing", lockedBy: "worker-1" });
    } finally {
      backendDb.close();
    }
  });

  it("clears the previous attempt's phase when it requeues a failed target", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db.insert(publications).values({ postId: 62, status: "published", createdAt: now, updatedAt: now }).run();
      backendDb.db
        .insert(publicationSources)
        .values({ postId: 62, itemJson: { text: "RU", text_en: "EN" }, createdAt: now, updatedAt: now })
        .run();
      const jobId = enqueuePublishJobTx(backendDb.db, {
        postId: 62,
        postKey: "post:62",
        messageId: 62,
        target: "threads_en",
        payload: { text: "RU", text_en: "EN" },
      });
      backendDb.db
        .update(publishJobs)
        .set({ status: "failed", currentPhase: "provider.publish", lastError: "boom" })
        .where(eq(publishJobs.jobId, jobId))
        .run();

      await runOperationCommand(backendDb, { action: "retry", ref: "post:62", target: "threads_en" });

      // A leftover phase would make recoverStalePublishJobs treat the next lost
      // lock as "the provider may already have run" and demand manual verification.
      const job = backendDb.db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get();
      expect(job).toMatchObject({ status: "queued", currentPhase: null, lastError: null, lockedBy: null });
    } finally {
      backendDb.close();
    }
  });
  it("requeues a site target through its render job, not as a publish job", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db.insert(publications).values({ postId: 90, status: "published", createdAt: now, updatedAt: now }).run();
      backendDb.db
        .insert(publicationSources)
        .values({ postId: 90, itemJson: { text: "RU", text_en: "EN" }, createdAt: now, updatedAt: now })
        .run();
      backendDb.db
        .insert(siteJobs)
        .values({
          postId: 90,
          messageId: 90,
          reason: "publish_ru",
          status: "failed",
          attemptCount: 2,
          lastError: "render boom",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(postTargets)
        .values({ postKey: "post:90", target: "site_ru", status: "failed", error: "render boom", skipped: 0, updatedAt: now })
        .run();

      const result = await runOperationCommand(backendDb, { action: "retry", ref: "post:90", target: "site_ru" });

      expect(result).toMatchObject({ ok: true, results: [{ target: "site_ru", outcome: "requeued" }] });
      expect(backendDb.db.select().from(siteJobs).get()).toMatchObject({ status: "queued", attemptCount: 0, lastError: null });
      // No publisher serves "site_ru": a publish job for it would be failed as an
      // unsupported target while the site itself was never re-rendered.
      expect(backendDb.db.select().from(publishJobs).all()).toEqual([]);
    } finally {
      backendDb.close();
    }
  });

  it("routes site and social targets apart when republishing a whole locale", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db.insert(publications).values({ postId: 91, status: "published", createdAt: now, updatedAt: now }).run();
      backendDb.db
        .insert(publicationSources)
        .values({ postId: 91, itemJson: { text: "RU", text_en: "EN" }, createdAt: now, updatedAt: now })
        .run();
      backendDb.db
        .insert(siteJobs)
        .values({ postId: 91, messageId: 91, reason: "publish_ru", status: "published", attemptCount: 1, createdAt: now, updatedAt: now })
        .run();
      for (const target of ["telegram", "site_ru"])
        backendDb.db.insert(postTargets).values({ postKey: "post:91", target, status: "published", skipped: 0, updatedAt: now }).run();

      await runOperationCommand(backendDb, { action: "retry", ref: "post:91", locale: "ru" });

      expect(
        backendDb.db
          .select()
          .from(publishJobs)
          .all()
          .map((job) => job.target),
      ).toEqual(["telegram"]);
      expect(backendDb.db.select().from(siteJobs).get()).toMatchObject({ status: "queued" });
    } finally {
      backendDb.close();
    }
  });
  it("rejects an unknown target before it becomes a durable job", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db.insert(publications).values({ postId: 92, status: "published", createdAt: now, updatedAt: now }).run();
      backendDb.db
        .insert(publicationSources)
        .values({ postId: 92, itemJson: { text: "RU", text_en: "EN" }, createdAt: now, updatedAt: now })
        .run();

      expect(runOperationCommand(backendDb, { action: "retry", ref: "post:92", target: "threds_en" })).rejects.toThrow(
        "unknown target: threds_en",
      );
      // Nothing durable was written on the way to the rejection.
      expect(backendDb.db.select().from(publishJobs).all()).toEqual([]);
    } finally {
      backendDb.close();
    }
  });
});
