import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

it("canonicalizes durable targets, resolves collisions, and makes publish job identity mandatory", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    db.exec(`
      CREATE TABLE post_targets (post_key text NOT NULL, target text NOT NULL, PRIMARY KEY(post_key, target));
      CREATE TABLE post_metrics (post_key text NOT NULL, target text NOT NULL, metric_name text NOT NULL, PRIMARY KEY(post_key, target, metric_name));
      CREATE TABLE metric_schedule (post_key text NOT NULL, target text NOT NULL, PRIMARY KEY(post_key, target));
      CREATE TABLE metric_samples (id integer PRIMARY KEY, target text NOT NULL);
      CREATE TABLE post_events (id integer PRIMARY KEY, target text);
      CREATE TABLE ops_actions (id integer PRIMARY KEY, target text);
      CREATE TABLE drafts (id integer PRIMARY KEY, targets_json text NOT NULL);
      CREATE TABLE channel_credentials (channel_id text, name text, value_encrypted text, updated_at text);
      CREATE TABLE channel_connections (id text PRIMARY KEY, source text NOT NULL);
      CREATE TABLE site_jobs (job_id integer PRIMARY KEY, reason text NOT NULL);
      CREATE TABLE runtime_usage (feature_key text NOT NULL);
      CREATE TABLE publish_jobs (
        job_id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        post_id integer,
        post_key text,
        message_id integer NOT NULL,
        target text NOT NULL,
        status text DEFAULT 'queued' NOT NULL,
        attempt_count integer DEFAULT 0 NOT NULL,
        publish_at text,
        next_attempt_at text,
        locked_by text,
        locked_at text,
        payload_json text,
        last_error text,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        current_phase text,
        reconcile_attempt_count integer DEFAULT 0 NOT NULL
      );
      CREATE UNIQUE INDEX idx_publish_jobs_post_target_status ON publish_jobs (post_key, target, status);
      CREATE INDEX idx_publish_jobs_message ON publish_jobs (message_id, target);
      CREATE INDEX idx_publish_jobs_due ON publish_jobs (status, publish_at, next_attempt_at, created_at);
      CREATE INDEX idx_publish_jobs_lock ON publish_jobs (locked_by, locked_at);
      CREATE INDEX idx_publish_jobs_post ON publish_jobs (post_id, target, status);

      INSERT INTO post_targets VALUES ('post:1', 'threads'), ('post:1', 'threads_ru'), ('post:2', 'twitter');
      INSERT INTO post_metrics VALUES ('post:1', 'instagram_story', 'views'), ('post:1', 'instagram_stories_ru', 'views');
      INSERT INTO metric_schedule VALUES ('post:1', 'telegram_story'), ('post:1', 'telegram_stories');
      INSERT INTO metric_samples VALUES (1, 'twitter');
      INSERT INTO post_events VALUES (1, 'threads');
      INSERT INTO ops_actions VALUES (1, 'instagram_story');
      INSERT INTO drafts VALUES (1, '{"threads":true,"twitter":true,"instagram_story":true,"telegram_story":true}');
      INSERT INTO channel_credentials VALUES ('x', 'token', 'encrypted', 'now');
      INSERT INTO channel_connections VALUES ('x', 'config');
      INSERT INTO site_jobs VALUES (1, 'publish_ru');
      INSERT INTO runtime_usage VALUES ('engagement.likes.toggle'), ('publishing.social.job');
      INSERT INTO publish_jobs (post_id, post_key, message_id, target, status, payload_json, created_at, updated_at)
      VALUES
        (1, 'post:1', 1, 'threads', 'queued', '{}', 'now', 'now'),
        (1, 'post:1', 1, 'threads_ru', 'queued', '{}', 'now', 'now'),
        (7, 'post:7', 7, 'x', 'failed', '{}', 'now', 'now'),
        (7, NULL, 7, 'twitter', 'failed', '{"telegram_story_local_path":"/tmp/story.mp4"}', 'now', 'now'),
        (9, NULL, 9, 'twitter', 'published', '{"telegram_story_local_path":"/tmp/story.mp4"}', 'now', 'now'),
        (NULL, NULL, 8, 'x', 'failed', '{}', 'now', 'now');
    `);

    const migration = readFileSync(path.join(import.meta.dir, "../drizzle/0005_canonicalize_publication_targets.sql"), "utf8");
    for (const statement of migration
      .split("--> statement-breakpoint")
      .map((value) => value.trim())
      .filter(Boolean))
      db.exec(statement);

    expect(db.query("SELECT post_key, target FROM post_targets ORDER BY post_key").all()).toEqual([
      { post_key: "post:1", target: "threads_ru" },
      { post_key: "post:2", target: "x" },
    ]);
    expect(db.query("SELECT target FROM post_metrics").all()).toEqual([{ target: "instagram_stories_ru" }]);
    expect(db.query("SELECT target FROM metric_schedule").all()).toEqual([{ target: "telegram_stories" }]);
    expect(db.query("SELECT target FROM metric_samples").get()).toEqual({ target: "x" });
    expect(db.query("SELECT target FROM post_events").get()).toEqual({ target: "threads_ru" });
    expect(db.query("SELECT target FROM ops_actions").get()).toEqual({ target: "instagram_stories_ru" });
    expect(db.query("SELECT targets_json FROM drafts").get()).toEqual({
      targets_json: '{"threads_ru":true,"x":true,"instagram_stories_ru":true,"telegram_stories":true}',
    });
    expect(db.query("SELECT post_key, target, payload_json FROM publish_jobs ORDER BY job_id").all()).toEqual([
      { post_key: "post:1", target: "threads_ru", payload_json: "{}" },
      { post_key: "post:7", target: "x", payload_json: "{}" },
      { post_key: "post:9", target: "x", payload_json: '{"telegramStoryLocalPath":"/tmp/story.mp4"}' },
    ]);
    expect(db.query("PRAGMA table_info(publish_jobs)").all()).toContainEqual(expect.objectContaining({ name: "post_key", notnull: 1 }));
    expect(db.query("PRAGMA table_info(publish_jobs)").all()).toContainEqual(expect.objectContaining({ name: "post_id", notnull: 1 }));
    expect(db.query("SELECT source FROM channel_connections").get()).toEqual({ source: "registry" });
    expect(db.query("SELECT reason FROM site_jobs").get()).toEqual({ reason: "site_ru" });
    expect(db.query("SELECT feature_key FROM runtime_usage").all()).toEqual([{ feature_key: "publishing.social.job" }]);
  } finally {
    db.close();
  }
});
