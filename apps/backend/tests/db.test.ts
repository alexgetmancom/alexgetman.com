import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftFromMessage, publishDraftToQueue } from "../src/bot.js";
import { baselineDrizzleMigrations, migrationStatus, openBackendDb } from "../src/db/client.js";

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
      expect(tables).toContain("credential_checks");
      expect(migrationStatus(backendDb.sqlite)).toHaveLength(2);
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
        "worker_state",
      ])
        expect(tables, table).toContain(table);
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
    fixture.close();

    const legacy = new Database(dbPath) as unknown as Parameters<typeof baselineDrizzleMigrations>[0];
    baselineDrizzleMigrations(legacy);
    legacy.close();
    const backendDb = openBackendDb(dbPath);
    try {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Production fixture", entities: [], media: [] });
      const postId = publishDraftToQueue(backendDb, draftId);
      expect(backendDb.sqlite.prepare("SELECT draft_id, status FROM publications WHERE post_id=?").get(postId)).toEqual({
        draft_id: draftId,
        status: "published",
      });
      expect(backendDb.sqlite.prepare("SELECT locale, slug FROM post_locales WHERE post_id=? ORDER BY locale").all(postId)).toEqual([
        { locale: "en", slug: "production-fixture" },
        { locale: "ru", slug: "production-fixture" },
      ]);
      expect(migrationStatus(backendDb.sqlite)).toHaveLength(2);
    } finally {
      backendDb.close();
    }
  });
});
