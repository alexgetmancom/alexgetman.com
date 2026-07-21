import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { baselineDrizzleMigrations, migrationStatus, openBackendDb } from "../src/db/client.js";
import { draftSources, postSources } from "../src/db/schema.js";
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

  it("bootstraps core pipeline tables", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const tables = backendDb.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((row: { name: string }) => row.name);
      expect(tables).toContain("publish_jobs");
      expect(tables).toContain("publish_plans");
      expect(tables).toContain("site_source_items");
      expect(tables).toContain("publication_plans");
      expect(tables).toContain("publication_sources");
      expect(tables).toContain("ops_actions");
      expect(tables).toContain("post_events");
      expect(tables).toContain("worker_state");
      expect(tables).toContain("posts");
      expect(tables).toContain("post_metrics");
      expect(tables).toContain("post_locales");
      expect(tables).toContain("media_assets");
      expect(tables).toContain("studio_media_assets");
      expect(tables).toContain("credential_checks");
      expect(tables).toContain("video_drafts");
      expect(tables).toContain("video_targets");
      expect(tables).toContain("creator_profiles");
      expect(tables).toContain("creator_profile_snapshots");
      expect(tables).toContain("video_metric_snapshots");
      expect(tables).toContain("social_comments");
      expect(tables).toContain("site_pageviews");
      expect(tables).toContain("post_sources");
      expect(tables).toContain("knowledge_entities");
      expect(tables).toContain("knowledge_entity_aliases");
      expect(tables).toContain("post_entity_links");
      expect(tables).toContain("draft_sources");
      expect(migrationStatus(backendDb.sqlite)).toHaveLength(19);
    } finally {
      backendDb.close();
    }
  });

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
        .prepare("INSERT INTO video_drafts (admin_id, label, asset_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
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
      "DROP TABLE draft_sources; DROP TABLE post_entity_links; DROP TABLE knowledge_entity_aliases; DROP TABLE knowledge_entities; DROP TABLE post_sources; DROP TABLE site_pageviews; DROP TABLE video_bot_sessions; DROP TABLE video_jobs; DROP TABLE video_targets; DROP TABLE video_drafts; DROP TABLE analytics_sync; DROP TABLE creator_profiles; DROP TABLE creator_profile_snapshots; DROP TABLE video_metric_snapshots; DROP TABLE social_comments; DROP TABLE admin_state; CREATE TABLE admin_state (admin_id integer PRIMARY KEY NOT NULL, action text, draft_id integer, updated_at text NOT NULL)",
    );
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
      expect(migrationStatus(backendDb.sqlite)).toHaveLength(19);
    } finally {
      backendDb.close();
    }
  });
});
