import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDirectory = join(import.meta.dir, "../drizzle");

function applyMigration(db: Database, name: string): void {
  const sql = readFileSync(join(migrationsDirectory, name), "utf8");
  for (const statement of sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean))
    db.run(statement);
}

test("requires Studio assets while preserving valid video history", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    for (const name of [
      "0000_baseline.sql",
      "0001_drop_dead_tables.sql",
      "0002_drop_unread_tables_and_columns.sql",
      "0003_index_metric_sample_times.sql",
      "0004_drop_unused_likes.sql",
      "0005_canonicalize_publication_targets.sql",
      "0006_remove_legacy_publication_paths.sql",
      "0007_persist_site_media_paths.sql",
    ])
      applyMigration(db, name);

    const now = new Date().toISOString();
    db.query(
      "INSERT INTO studio_media_assets(id,actor_id,kind,mime_type,filename,local_path,byte_size,sha256,source,created_at) VALUES (1,1,'video','video/mp4','valid.mp4','/tmp/valid.mp4',1,'valid','test',?)",
    ).run(now);
    db.query(
      "INSERT INTO video_drafts(id,actor_id,label,asset_key,studio_media_asset_id,status,created_at,updated_at) VALUES (1,1,'valid','valid',1,'published',?,?), (2,1,'legacy','legacy',NULL,'cancelled',?,?)",
    ).run(now, now, now, now);
    db.run(
      "INSERT INTO video_targets(id,video_draft_id,target,metadata_json,status,created_at,updated_at) VALUES (1,1,'youtube_shorts','{}','published','2026-01-01','2026-01-01'), (2,2,'youtube_shorts','{}','cancelled','2026-01-01','2026-01-01')",
    );
    db.run(
      "INSERT INTO video_jobs(id,video_draft_id,video_target_id,kind,run_at,status,created_at,updated_at) VALUES (1,1,1,'publish','2026-01-01','completed','2026-01-01','2026-01-01'), (2,2,2,'publish','2026-01-01','completed','2026-01-01','2026-01-01')",
    );

    applyMigration(db, "0008_require_video_studio_assets.sql");

    expect(db.query("SELECT id,studio_media_asset_id FROM video_drafts").all()).toEqual([{ id: 1, studio_media_asset_id: 1 }]);
    expect(db.query("SELECT id,video_draft_id FROM video_targets").all()).toEqual([{ id: 1, video_draft_id: 1 }]);
    expect(db.query("SELECT id,video_draft_id FROM video_jobs").all()).toEqual([{ id: 1, video_draft_id: 1 }]);
    const columns = db.query("PRAGMA table_info(video_drafts)").all() as Array<{ name: string; notnull: number }>;
    expect(columns.some((column) => column.name === "asset_key")).toBe(false);
    expect(columns.find((column) => column.name === "studio_media_asset_id")?.notnull).toBe(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
