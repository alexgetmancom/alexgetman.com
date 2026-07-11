import { describe, expect, it } from "bun:test";
import { asc, count, eq } from "drizzle-orm";
import { openBackendDb } from "../src/db/client.js";
import { publicationSources, publications, publishJobs } from "../src/db/schema.js";
import { enqueuePublishJob } from "../src/queue/publish.js";
import { runCommandAction } from "../src/services/actions.js";

describe("command center actions", () => {
  it("rebuilds retried jobs from the source using the target locale", () => {
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
        .values({ postId: 52, status: "published", telegramMessageId: 492, createdAt: now, updatedAt: now })
        .run();
      backendDb.db
        .insert(publicationSources)
        .values({ postId: 52, itemJson: JSON.stringify(source), createdAt: now, updatedAt: now })
        .run();

      for (const target of ["threads_ru", "threads_en"]) {
        const id = enqueuePublishJob(backendDb, { postId: 52, postKey: "post:52", messageId: 52, target, payload: source });
        backendDb.db.update(publishJobs).set({ status: "failed" }).where(eq(publishJobs.jobId, id)).run();
        runCommandAction(backendDb, { action: "retry", ref: "post:52", target });
      }

      const jobs = backendDb.db
        .select({ target: publishJobs.target, payloadJson: publishJobs.payloadJson })
        .from(publishJobs)
        .where(eq(publishJobs.postId, 52))
        .orderBy(asc(publishJobs.target))
        .all();
      const payloads = Object.fromEntries(jobs.map((job) => [job.target, JSON.parse(job.payloadJson!) as Record<string, unknown>]));
      expect(payloads.threads_ru).toMatchObject({ locale: "ru", text: "Русский текст", text_en: "", media: [{ file_id: "ru-photo" }] });
      expect(payloads.threads_en).toMatchObject({
        locale: "en",
        text: "English text",
        text_en: "English text",
        media: [{ file_id: "en-photo" }],
      });
      expect(backendDb.db.select({ count: count() }).from(publishJobs).where(eq(publishJobs.postId, 52)).get()!.count).toBe(2);
    } finally {
      backendDb.close();
    }
  });
});
