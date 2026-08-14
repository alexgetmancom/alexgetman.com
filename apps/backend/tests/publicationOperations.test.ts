import { expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/foundation/config.js";
import type { OperationContext } from "../src/operations/registry.js";
import { runOperation } from "../src/operations/registry.js";
import { publicationTimeline } from "../src/operations/timeline.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { openBackendDb } from "./helpers/open-db.js";

function context(db: ReturnType<typeof openBackendDb>, fetchImpl: typeof fetch = fetch): OperationContext {
  return {
    dbPath: ":memory:",
    config: () => loadConfig({ CONTROLLER_ADMIN_IDS: "42" }),
    db: () => db,
    fetchImpl,
    actorType: "test",
  };
}

function connectThreads(backendDb: ReturnType<typeof openBackendDb>): void {
  createStudioServices(backendDb, loadConfig({ CONTROLLER_ADMIN_IDS: "42" })).channels.connect({
    platform: "threads_ru",
    locale: "ru",
    provider: "native",
    targetId: "threads_ru",
    label: "Threads RU",
  });
}

it("publishes operator text to exactly the requested target in one operation", async () => {
  const backendDb = openBackendDb(":memory:");
  try {
    connectThreads(backendDb);
    const result = (await runOperation("publish", context(backendDb), {
      locale: "ru",
      targets: "threads_ru",
      text: "Test publication",
    })) as { draft_id: number; post_id: number; ref: string };

    expect(result).toMatchObject({
      ref: `post:${result.post_id}`,
      targets: ["threads_ru"],
      queued: true,
    });
    const draft = backendDb.sqlite.query("SELECT targets_json FROM drafts WHERE id=?").get(result.draft_id) as { targets_json: string };
    expect(JSON.parse(draft.targets_json)).toEqual({
      telegram: false,
      site_ru: false,
      site_en: false,
      threads_ru: true,
      threads_en: false,
      x: false,
      discord: false,
      telegram_stories: false,
      instagram_stories_ru: false,
      instagram_stories: false,
    });
    expect(backendDb.sqlite.query("SELECT target FROM publish_jobs WHERE post_id=?").all(result.post_id)).toEqual([
      { target: "threads_ru" },
    ]);
  } finally {
    backendDb.close();
  }
});

it("does not require a Story decision when every Story target is disabled", () => {
  const backendDb = openBackendDb(":memory:");
  const ruCard = join(tmpdir(), `story-card-ru-${crypto.randomUUID()}.png`);
  const enCard = join(tmpdir(), `story-card-en-${crypto.randomUUID()}.png`);
  writeFileSync(ruCard, "ru");
  writeFileSync(enCard, "en");
  try {
    const config = loadConfig({ CONTROLLER_ADMIN_IDS: "42" });
    const posts = createStudioServices(backendDb, config).posts;
    const draftId = posts.create(
      42,
      {
        text: "No Stories",
        textEnApproved: "No Stories",
        entities: [],
        media: [],
      },
      { targets: ["threads_ru"] },
    );
    const now = new Date().toISOString();
    backendDb.sqlite
      .query("UPDATE draft_story_cards SET status='ready',local_path=?,updated_at=? WHERE draft_id=? AND locale='ru'")
      .run(ruCard, now, draftId);
    backendDb.sqlite
      .query("UPDATE draft_story_cards SET status='ready',local_path=?,updated_at=? WHERE draft_id=? AND locale='en'")
      .run(enCard, now, draftId);

    expect(posts.publish(42, draftId)).toBeGreaterThan(0);
  } finally {
    backendDb.close();
    rmSync(ruCard, { force: true });
    rmSync(enCard, { force: true });
  }
});

it("purges an absent publication and every stored publication path", async () => {
  const backendDb = openBackendDb(":memory:");
  try {
    connectThreads(backendDb);
    const published = (await runOperation("publish", context(backendDb), {
      locale: "ru",
      targets: "threads_ru",
      text: "Disposable test",
    })) as { draft_id: number; post_id: number; ref: string };
    const now = new Date().toISOString();
    backendDb.sqlite
      .query(
        "INSERT INTO post_targets(post_key,target,status,url,updated_at) VALUES (?,'threads_ru','published','https://threads.example/deleted',?)",
      )
      .run(published.ref, now);
    backendDb.sqlite.query("INSERT INTO metric_schedule(post_key,target,updated_at) VALUES (?,'threads_ru',?)").run(published.ref, now);
    backendDb.sqlite
      .query(
        "INSERT INTO studio_notification_jobs(actor_id,ref,kind,run_at,status,created_at,updated_at) VALUES (42,?,'completion',?,'delivered',?,?)",
      )
      .run(published.ref, now, now, now);
    const stillLive = (async () => new Response("live", { status: 200 })) as unknown as typeof fetch;
    await expect(
      runOperation("purge", context(backendDb, stillLive), {
        ref: published.ref,
        apply: true,
      }),
    ).rejects.toThrow("threads_ru is still reachable");
    const notFound = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;

    const plan = (await runOperation("purge", context(backendDb, notFound), {
      ref: published.ref,
    })) as {
      applied: boolean;
      rows: Record<string, number>;
    };
    expect(plan.applied).toBe(false);
    expect(plan.rows).toMatchObject({
      drafts: 1,
      publications: 1,
      publish_jobs: 1,
      post_targets: 1,
      notification_jobs: 1,
    });

    const result = (await runOperation("purge", context(backendDb, notFound), {
      ref: published.ref,
      apply: true,
    })) as {
      applied: boolean;
    };
    expect(result.applied).toBe(true);
    expect(publicationTimeline(backendDb, published.ref)).toEqual({
      ref: published.ref,
      jobs: [],
      targets: [],
      events: [],
    });
    expect(backendDb.sqlite.query("SELECT COUNT(*) AS count FROM drafts WHERE id=?").get(published.draft_id)).toEqual({ count: 0 });
    expect(backendDb.sqlite.query("SELECT COUNT(*) AS count FROM metric_schedule WHERE post_key=?").get(published.ref)).toEqual({
      count: 0,
    });
    expect(backendDb.sqlite.query("SELECT COUNT(*) AS count FROM studio_notification_jobs WHERE ref=?").get(published.ref)).toEqual({
      count: 0,
    });
  } finally {
    backendDb.close();
  }
});
