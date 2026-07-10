import { describe, expect, it } from "vitest";
import { openBackendDb } from "../src/db/client.js";
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
      backendDb.sqlite.prepare("INSERT INTO publications(post_id,status,telegram_message_id,created_at,updated_at) VALUES (52,'published',492,?,?)").run(now, now);
      backendDb.sqlite.prepare("INSERT INTO publication_sources(post_id,item_json,created_at,updated_at) VALUES (52,?,?,?)").run(JSON.stringify(source), now, now);

      for (const target of ["threads_ru", "threads_en"]) {
        const id = enqueuePublishJob(backendDb, { postId: 52, postKey: "post:52", messageId: 52, target, payload: source });
        backendDb.sqlite.prepare("UPDATE publish_jobs SET status='failed' WHERE job_id=?").run(id);
        runCommandAction(backendDb, { action: "retry", ref: "post:52", target });
      }

      const jobs = backendDb.sqlite.prepare("SELECT target,payload_json FROM publish_jobs WHERE post_id=52 AND status='queued' ORDER BY target").all() as Array<{ target: string; payload_json: string }>;
      const payloads = Object.fromEntries(jobs.map((job) => [job.target, JSON.parse(job.payload_json) as Record<string, unknown>]));
      expect(payloads.threads_ru).toMatchObject({ locale: "ru", text: "Русский текст", text_en: "", media: [{ file_id: "ru-photo" }] });
      expect(payloads.threads_en).toMatchObject({ locale: "en", text: "English text", text_en: "English text", media: [{ file_id: "en-photo" }] });
      expect((backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM publish_jobs WHERE post_id=52").get() as { count: number }).count).toBe(2);
    } finally {
      backendDb.close();
    }
  });
});
