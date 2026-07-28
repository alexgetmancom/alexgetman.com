import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { baselineDrizzleMigrations, drizzleMigrationMetadata, migrationStatus, openBackendDb } from "../src/db/client.js";
import { draftSources, knowledgeEntities, postEntityLinks, postSources } from "../src/db/schema.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";

describe("openBackendDb", () => {
  it("enables WAL, busy timeout and foreign keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-backend-"));
    const backendDb = openBackendDb(join(dir, "pipeline.db"), 5000);
    try {
      expect(backendDb.sqlite.query("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      expect(backendDb.sqlite.query("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 5000 });
      expect(backendDb.sqlite.query("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    } finally {
      backendDb.close();
    }
  });

  it("applies every migration on a fresh database", () => {
    // The table inventory this used to spell out was a copy of the schema: each
    // new table meant one more line, and it only ever caught a migration that
    // had not run at all — which every other test here would fail on anyway.
    // Applying the full migration list is the fact worth asserting.
    const backendDb = openBackendDb(":memory:");
    try {
      expect(migrationStatus(backendDb.sqlite)).toHaveLength(drizzleMigrationMetadata().length);
    } finally {
      backendDb.close();
    }
  });

  /** The one inventory worth maintaining by hand: it guards the destructive
   * direction. A migration that drops or renames a table still applies cleanly
   * and passes every behavioural test whose data it did not touch, and the loss
   * only surfaces on production data. One line per new table is the price. */
  it("preserves every legacy pipeline table when applying Drizzle migrations", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const tables = new Set(
        backendDb.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row: { name: string }) => row.name),
      );
      for (const table of [
        "admin_state",
        "alert_dedup",
        "analytics_rollups",
        "content_memory",
        "credential_checks",
        "deployment_snapshots",
        "drafts",
        "media_assets",
        "media_test_cases",
        "media_test_results",
        "metric_samples",
        "metric_schedule",
        "ops_actions",
        "pending_albums",
        "platform_capabilities",
        "platform_rules",
        "post_events",
        "post_lifecycle",
        "post_locales",
        "post_metrics",
        "post_targets",
        "posts",
        "publication_plans",
        "publication_sources",
        "publications",
        "publish_jobs",
        "publish_plans",
        "site_jobs",
        "site_source_items",
        "studio_media_assets",
        "worker_state",
      ])
        expect(tables, table).toContain(table);
    } finally {
      backendDb.close();
    }
  });

  it("cascades video dependencies at the database level", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.sqlite
        .prepare("INSERT INTO video_drafts (actor_id, label, asset_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(1, "", "asset", "draft", now, now);
      backendDb.sqlite
        .prepare(
          "INSERT INTO video_targets (video_draft_id, target, metadata_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(1, "youtube_shorts", "{}", "draft", now, now);
      backendDb.sqlite
        .prepare(
          "INSERT INTO video_jobs (video_draft_id, video_target_id, kind, run_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(1, 1, "publish", now, "queued", now, now);
      backendDb.sqlite
        .prepare("INSERT INTO video_metric_snapshots (video_target_id, platform, metrics_json, sampled_at) VALUES (?, ?, ?, ?)")
        .run(1, "youtube_shorts", "{}", now);
      backendDb.sqlite
        .prepare("INSERT INTO video_metric_schedule (video_target_id, next_check_at, updated_at) VALUES (?, ?, ?)")
        .run(1, now, now);
      backendDb.sqlite
        .prepare("INSERT INTO social_comments (platform, comment_id, video_target_id, text, fetched_at) VALUES (?, ?, ?, ?, ?)")
        .run("youtube", "comment", 1, "x", now);

      backendDb.sqlite.prepare("DELETE FROM video_drafts WHERE id=?").run(1);

      for (const table of ["video_targets", "video_jobs", "video_metric_snapshots", "video_metric_schedule", "social_comments"])
        expect(backendDb.sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    } finally {
      backendDb.close();
    }
  });

  it("publishes against the production publications schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-production-schema-"));
    const dbPath = join(dir, "pipeline.db");
    const initial = openBackendDb(dbPath);
    initial.close();
    const fixture = new Database(dbPath);
    fixture.exec("DROP TABLE __drizzle_migrations");
    fixture.exec(
      "DROP TABLE channel_connections; DROP TABLE draft_entity_candidates; DROP TABLE draft_sources; DROP TABLE post_entity_links; DROP TABLE knowledge_entity_aliases; DROP TABLE knowledge_entities; DROP TABLE post_sources; DROP TABLE site_pageviews; DROP TABLE video_bot_sessions; DROP TABLE video_jobs; DROP TABLE video_targets; DROP TABLE video_drafts; DROP TABLE analytics_sync; DROP TABLE creator_profiles; DROP TABLE creator_profile_snapshots; DROP TABLE video_metric_snapshots; DROP TABLE video_metric_schedule; DROP TABLE social_comments; DROP TABLE admin_state; CREATE TABLE admin_state (admin_id integer PRIMARY KEY NOT NULL, action text, draft_id integer, updated_at text NOT NULL)",
    );
    // The fixture is built by the current migration chain and then replayed from
    // the baseline, so every column 0030 renames has to be put back to its
    // pre-0030 spelling first. That is also what a restored production dump
    // looks like, which is the whole point of this test.
    for (const table of [
      "drafts",
      "pending_albums",
      "studio_notification_settings",
      "studio_notification_jobs",
      "studio_media_assets",
      "bot_settings",
      "bot_ui_settings",
    ])
      fixture.exec(`ALTER TABLE ${table} RENAME COLUMN actor_id TO admin_id`);
    // Same reason, one migration later: 0031 adds a column to a table this
    // fixture keeps, and SQLite has no ADD COLUMN IF NOT EXISTS.
    fixture.exec("ALTER TABLE drafts DROP COLUMN threads_chain_approved");
    fixture.exec("ALTER TABLE publish_jobs DROP COLUMN current_phase");
    fixture.exec("ALTER TABLE post_targets DROP COLUMN confirmation_source");
    fixture.exec("ALTER TABLE post_targets DROP COLUMN verified_at");
    fixture.close();

    const legacy = new Database(dbPath) as unknown as Parameters<typeof baselineDrizzleMigrations>[0];
    baselineDrizzleMigrations(legacy);
    legacy.close();
    const backendDb = openBackendDb(dbPath);
    try {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Production fixture", entities: [], media: [] });
      backendDb.db
        .insert(draftSources)
        .values({
          draftId,
          url: "https://example.com/announcement",
          labelRu: "example.com",
          labelEn: "example.com",
          sortOrder: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();
      const postId = publishDraftToQueue(backendDb, draftId);
      expect(backendDb.sqlite.prepare("SELECT draft_id, status FROM publications WHERE post_id=?").get(postId)).toEqual({
        draft_id: draftId,
        status: "scheduled",
      });
      expect(backendDb.sqlite.prepare("SELECT locale, slug FROM post_locales WHERE post_id=? ORDER BY locale").all(postId)).toEqual([
        { locale: "en", slug: "production-fixture" },
        { locale: "ru", slug: "production-fixture" },
      ]);
      expect(backendDb.db.select({ url: postSources.url }).from(postSources).all()).toEqual([{ url: "https://example.com/announcement" }]);
      expect(migrationStatus(backendDb.sqlite)).toHaveLength(drizzleMigrationMetadata().length);
    } finally {
      backendDb.close();
    }
  });

  it("links a published model to its company without an editor confirmation", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const draftId = createDraftFromMessage(backendDb, 42, {
        text: "Claude received a new update",
        textEn: "Claude received a new update",
        entities: [],
        media: [],
      });
      const postId = publishDraftToQueue(backendDb, draftId);
      const linked = backendDb.db
        .select({ slug: knowledgeEntities.slug, role: postEntityLinks.linkRole })
        .from(postEntityLinks)
        .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, postEntityLinks.entityId))
        .where(eq(postEntityLinks.postId, postId))
        .all()
        .sort((left, right) => left.slug.localeCompare(right.slug));
      expect(linked).toEqual([
        { slug: "anthropic", role: "mention" },
        { slug: "claude", role: "focus" },
      ]);
    } finally {
      backendDb.close();
    }
  });

  it("keeps a comparison as a mention instead of making it a hub update", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const draftId = createDraftFromMessage(backendDb, 42, {
        text: "Qwen announced a new flagship\n\nIt competes with Claude Fable.",
        textEn: "Qwen announced a new flagship\n\nIt competes with Claude Fable.",
        entities: [],
        media: [],
      });
      const postId = publishDraftToQueue(backendDb, draftId);
      const links = backendDb.db
        .select({ slug: knowledgeEntities.slug, role: postEntityLinks.linkRole })
        .from(postEntityLinks)
        .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, postEntityLinks.entityId))
        .where(eq(postEntityLinks.postId, postId))
        .all();
      expect(links).toContainEqual({ slug: "claude", role: "mention" });
      expect(links).toContainEqual({ slug: "fable-5", role: "mention" });
    } finally {
      backendDb.close();
    }
  });

  it("does not treat a competitor headline as a Claude hub update", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const draftId = createDraftFromMessage(backendDb, 42, {
        text: "Grok 4.5 is a new competitor to GPT and Claude\n\nThe release is now available.",
        textEn: "Grok 4.5 is a new competitor to GPT and Claude\n\nThe release is now available.",
        entities: [],
        media: [],
      });
      const postId = publishDraftToQueue(backendDb, draftId);
      const link = backendDb.db
        .select({ role: postEntityLinks.linkRole })
        .from(postEntityLinks)
        .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, postEntityLinks.entityId))
        .where(and(eq(postEntityLinks.postId, postId), eq(knowledgeEntities.slug, "claude")))
        .get();
      expect(link).toEqual({ role: "mention" });
    } finally {
      backendDb.close();
    }
  });

  it("recognizes Codex as the focus only when it is the subject or the tool used", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const directDraft = createDraftFromMessage(backendDb, 42, {
        text: "GPT ported RollerCoaster Tycoon to iPad\n\nThe developer built it with Codex.",
        textEn: "GPT ported RollerCoaster Tycoon to iPad\n\nThe developer built it with Codex.",
        entities: [],
        media: [],
      });
      const directPostId = publishDraftToQueue(backendDb, directDraft);
      const direct = backendDb.db
        .select({ role: postEntityLinks.linkRole })
        .from(postEntityLinks)
        .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, postEntityLinks.entityId))
        .where(and(eq(postEntityLinks.postId, directPostId), eq(knowledgeEntities.slug, "codex")))
        .get();
      expect(direct).toEqual({ role: "focus" });

      const asideDraft = createDraftFromMessage(backendDb, 42, {
        text: "Claude reset limits\n\nI was too busy using Codex to notice.",
        textEn: "Claude reset limits\n\nI was too busy using Codex to notice.",
        entities: [],
        media: [],
      });
      const asidePostId = publishDraftToQueue(backendDb, asideDraft);
      const aside = backendDb.db
        .select({ role: postEntityLinks.linkRole })
        .from(postEntityLinks)
        .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, postEntityLinks.entityId))
        .where(and(eq(postEntityLinks.postId, asidePostId), eq(knowledgeEntities.slug, "codex")))
        .get();
      expect(aside).toEqual({ role: "mention" });
    } finally {
      backendDb.close();
    }
  });
});
