import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

it("cuts publication refs over to their short public form without deleting video history", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE post_events (id integer PRIMARY KEY, post_key text);
      CREATE TABLE studio_notification_jobs (id integer PRIMARY KEY, ref text NOT NULL, kind text NOT NULL, status text NOT NULL);
      CREATE UNIQUE INDEX idx_studio_notification_jobs_ref_kind ON studio_notification_jobs (ref, kind);
      CREATE TABLE video_drafts (id integer PRIMARY KEY, studio_media_asset_id integer);
      CREATE TABLE video_targets (
        id integer PRIMARY KEY,
        video_draft_id integer NOT NULL REFERENCES video_drafts(id) ON DELETE CASCADE
      );
      CREATE TABLE video_jobs (
        id integer PRIMARY KEY,
        video_draft_id integer NOT NULL REFERENCES video_drafts(id) ON DELETE CASCADE,
        video_target_id integer REFERENCES video_targets(id) ON DELETE CASCADE
      );
      CREATE TABLE video_metric_snapshots (
        id integer PRIMARY KEY,
        video_target_id integer NOT NULL REFERENCES video_targets(id) ON DELETE CASCADE
      );
      CREATE TABLE social_comments (
        id integer PRIMARY KEY,
        video_target_id integer NOT NULL REFERENCES video_targets(id) ON DELETE CASCADE
      );

      INSERT INTO post_events VALUES
        (1, 'post:7'),
        (2, 'publication:video:8'),
        (3, 'runtime');
      INSERT INTO studio_notification_jobs VALUES
        (1, 'video:8', 'reminder', 'delivered'),
        (2, 'publication:video:8', 'reminder', 'delivered'),
        (3, 'post:7', 'completion', 'delivered');
      INSERT INTO video_drafts VALUES (8, NULL);
      INSERT INTO video_targets VALUES (80, 8);
      INSERT INTO video_jobs VALUES (800, 8, 80);
      INSERT INTO video_metric_snapshots VALUES (8000, 80);
      INSERT INTO social_comments VALUES (80000, 80);
    `);

    for (const migrationName of ["0006_remove_legacy_publication_paths.sql", "0018_short_publication_refs.sql"]) {
      const migration = readFileSync(path.join(import.meta.dir, `../drizzle/${migrationName}`), "utf8");
      for (const statement of migration
        .split("--> statement-breakpoint")
        .map((value) => value.trim())
        .filter(Boolean))
        db.exec(statement);
    }

    expect(db.query("SELECT post_key FROM post_events ORDER BY id").all()).toEqual([
      { post_key: "post:7" },
      { post_key: "video:8" },
      { post_key: "runtime" },
    ]);
    expect(db.query("SELECT ref, kind FROM studio_notification_jobs ORDER BY id").all()).toEqual([
      { ref: "video:8", kind: "reminder" },
      { ref: "post:7", kind: "completion" },
    ]);
    expect(db.query("SELECT COUNT(*) AS count FROM video_drafts").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM video_targets").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM video_jobs").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM video_metric_snapshots").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM social_comments").get()).toEqual({ count: 1 });
  } finally {
    db.close();
  }
});
