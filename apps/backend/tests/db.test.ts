import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { baselineDrizzleMigrations, drizzleMigrationMetadata, migrationStatus } from "../src/db/client.js";
import { knowledgeEntities, postEntityLinks } from "../src/db/schema.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { openBackendDb } from "./helpers/open-db.js";

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

  it("leaves a baselined database alone instead of recreating its schema", () => {
    // How production is adopted: the schema is already there and the baseline
    // must be recorded as applied, not replayed. Getting this wrong throws
    // "table already exists" on the next boot.
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-baseline-"));
    const dbPath = join(dir, "pipeline.db");
    const initial = openBackendDb(dbPath);
    initial.close();

    const raw = new Database(dbPath) as unknown as Parameters<typeof baselineDrizzleMigrations>[0];
    raw.run("DELETE FROM __drizzle_migrations");
    expect(baselineDrizzleMigrations(raw)).toEqual(drizzleMigrationMetadata());
    raw.close();

    const backendDb = openBackendDb(dbPath);
    try {
      expect(migrationStatus(backendDb.sqlite)).toEqual(drizzleMigrationMetadata());
      expect(backendDb.db.select().from(knowledgeEntities).all().length).toBeGreaterThan(0);
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
        "conversation_sessions",
        "alert_dedup",
        "analytics_rollups",
        "credential_checks",
        "deployment_snapshots",
        "drafts",
        "media_test_cases",
        "media_test_results",
        "metric_samples",
        "metric_schedule",
        "ops_actions",
        "pending_albums",
        "platform_capabilities",
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
        "runtime_usage",
        "runtime_memory_samples",
        "site_jobs",
        "site_source_items",
        "studio_media_assets",
        "studio_weekly_digest_settings",
        "worker_state",
        "x_activity_imports",
        "x_activity_items",
        "x_activity_metric_snapshots",
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

  it("enforces one video metric snapshot per checkpoint while allowing uncheckpointed rows", () => {
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

      const insert = backendDb.sqlite.prepare(
        "INSERT INTO video_metric_snapshots (video_target_id, platform, metrics_json, checkpoint_index, sampled_at) VALUES (?, ?, ?, ?, ?)",
      );
      insert.run(1, "youtube_shorts", "{}", 1, now);
      expect(() => insert.run(1, "youtube_shorts", "{}", 1, now)).toThrow();
      expect(() => insert.run(1, "youtube_shorts", "{}", null, now)).not.toThrow();
      expect(() => insert.run(1, "youtube_shorts", "{}", null, now)).not.toThrow();
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
