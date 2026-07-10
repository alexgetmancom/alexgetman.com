import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";

export type BackendDb = {
  sqlite: SqliteCompat;
  db: BunSQLiteDatabase<typeof schema>;
  close: () => void;
};

type SqliteCompat = Omit<Database, "prepare" | "query"> & {
  prepare: (sql: string) => any;
  query: (sql: string) => any;
  backup: (target: string) => Promise<void>;
};

export function openBackendDb(path: string, timeout = 30_000): BackendDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path, { create: true, strict: true }) as SqliteCompat;
  sqlite.backup = async (target: string) => { await Bun.write(target, sqlite.serialize()); };
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run(`PRAGMA busy_timeout = ${timeout}`);
  sqlite.run("PRAGMA foreign_keys = ON");
  ensureCoreSchema(sqlite);
  const db = drizzle(sqlite, { schema });
  return {
    sqlite,
    db,
    close: () => sqlite.close(),
  };
}

function ensureCoreSchema(sqlite: SqliteCompat): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS publish_jobs (
      job_id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER,
      post_key TEXT,
      message_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      publish_at TEXT,
      next_attempt_at TEXT,
      locked_by TEXT,
      locked_at TEXT,
      payload_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(message_id, target, status)
    );
    CREATE INDEX IF NOT EXISTS idx_publish_jobs_due
      ON publish_jobs(status, publish_at, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_publish_jobs_lock
      ON publish_jobs(locked_by, locked_at);
    CREATE INDEX IF NOT EXISTS idx_publish_jobs_post
      ON publish_jobs(post_id, target, status);

    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'needs_review',
      text_ru TEXT NOT NULL DEFAULT '',
      text_en_machine TEXT,
      text_en_approved TEXT,
      targets_json TEXT,
      media_ru_json TEXT,
      media_en_json TEXT,
      text_ru_entities_json TEXT,
      text_en_entities_json TEXT,
      channel_message_id INTEGER,
      scheduled_at TEXT,
      scheduled_en_at TEXT,
      publish_mode TEXT,
      post_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_status
      ON drafts(status, created_at);

    CREATE TABLE IF NOT EXISTS publications (
      post_id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id INTEGER UNIQUE,
      status TEXT NOT NULL DEFAULT 'draft',
      telegram_message_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS post_locales (
      post_id INTEGER NOT NULL,
      locale TEXT NOT NULL,
      slug TEXT NOT NULL,
      text TEXT,
      html TEXT,
      entities_json TEXT,
      media_json TEXT,
      site_enabled INTEGER NOT NULL DEFAULT 0,
      published_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (post_id, locale),
      FOREIGN KEY (post_id) REFERENCES publications(post_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS worker_state (
      name TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS publish_plans (
      message_id INTEGER PRIMARY KEY,
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_source_items (
      message_id INTEGER PRIMARY KEY,
      item_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS publication_plans (
      post_id INTEGER PRIMARY KEY,
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS publication_sources (
      post_id INTEGER PRIMARY KEY,
      item_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS post_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_key TEXT,
      event_type TEXT NOT NULL DEFAULT 'ops.event',
      severity TEXT NOT NULL DEFAULT 'info',
      target TEXT,
      message TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL,
      acked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_post_events_lookup
      ON post_events(post_key, target, created_at);

    CREATE TABLE IF NOT EXISTS ops_actions (
      action_id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_type TEXT NOT NULL,
      action TEXT NOT NULL,
      message_id INTEGER,
      target TEXT,
      status TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS site_jobs (
      job_id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER,
      message_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      locked_by TEXT,
      locked_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_site_jobs_due
      ON site_jobs(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_site_jobs_lock
      ON site_jobs(locked_by, locked_at);
    CREATE INDEX IF NOT EXISTS idx_site_jobs_post
      ON site_jobs(post_id, status);

    CREATE TABLE IF NOT EXISTS posts (
      post_key TEXT PRIMARY KEY,
      post_id INTEGER,
      source TEXT NOT NULL DEFAULT 'telegram',
      channel TEXT NOT NULL DEFAULT '',
      chat_id TEXT,
      message_id INTEGER NOT NULL,
      date_utc TEXT,
      date_msk TEXT,
      text TEXT,
      text_en TEXT,
      html TEXT,
      html_en TEXT,
      media_json TEXT,
      media_count INTEGER NOT NULL DEFAULT 0,
      media_types_json TEXT,
      site_ru_path TEXT,
      site_en_path TEXT,
      telegram_url TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      raw_json TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_channel_message ON posts(channel, message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_post_id ON posts(post_id) WHERE post_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS post_targets (
      post_key TEXT NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      external_id TEXT,
      external_ids_json TEXT,
      url TEXT,
      error TEXT,
      skipped INTEGER NOT NULL DEFAULT 0,
      published_at TEXT,
      updated_at TEXT NOT NULL,
      raw_json TEXT,
      PRIMARY KEY (post_key, target)
    );

    CREATE TABLE IF NOT EXISTS post_metrics (
      post_key TEXT NOT NULL,
      target TEXT NOT NULL,
      metric_name TEXT NOT NULL DEFAULT 'views',
      value INTEGER,
      unit TEXT NOT NULL DEFAULT 'count',
      source TEXT,
      sampled_at TEXT,
      error TEXT,
      raw_json TEXT,
      PRIMARY KEY (post_key, target, metric_name)
    );

    CREATE TABLE IF NOT EXISTS metric_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_key TEXT NOT NULL,
      target TEXT NOT NULL,
      metric_name TEXT NOT NULL DEFAULT 'views',
      value INTEGER,
      sampled_at TEXT NOT NULL,
      source TEXT,
      raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_metric_samples_lookup
      ON metric_samples(post_key, target, metric_name, sampled_at);

    CREATE TABLE IF NOT EXISTS metric_schedule (
      post_key TEXT NOT NULL,
      target TEXT NOT NULL,
      next_check_at TEXT,
      last_checked_at TEXT,
      check_count INTEGER NOT NULL DEFAULT 0,
      frozen_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (post_key, target)
    );

    CREATE TABLE IF NOT EXISTS admin_state (
      admin_id INTEGER PRIMARY KEY,
      action TEXT,
      draft_id INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_albums (
      id TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      media_group_id TEXT NOT NULL,
      action TEXT,
      draft_id INTEGER,
      text_ru TEXT NOT NULL DEFAULT '',
      media_json TEXT NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      text_entities_json TEXT
    );

    CREATE TABLE IF NOT EXISTS post_lifecycle (
      post_key TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      previous_state TEXT,
      entered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reason TEXT,
      raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_post_lifecycle_state ON post_lifecycle(state, updated_at);

    CREATE TABLE IF NOT EXISTS media_assets (
      asset_key TEXT PRIMARY KEY,
      post_key TEXT,
      draft_id INTEGER,
      locale TEXT NOT NULL DEFAULT 'ru',
      role TEXT NOT NULL DEFAULT 'original',
      media_type TEXT,
      file_id TEXT,
      source_path TEXT,
      public_url TEXT,
      sha256 TEXT,
      size_bytes INTEGER,
      width INTEGER,
      height INTEGER,
      duration_seconds REAL,
      variant_of TEXT,
      status TEXT NOT NULL DEFAULT 'known',
      details_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_assets_hash ON media_assets(sha256);
    CREATE INDEX IF NOT EXISTS idx_media_assets_post ON media_assets(post_key, locale, role);

    CREATE TABLE IF NOT EXISTS platform_rules (
      target TEXT NOT NULL,
      format_key TEXT NOT NULL,
      support_status TEXT NOT NULL DEFAULT 'unknown',
      max_items INTEGER,
      notes TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (target, format_key)
    );

    CREATE TABLE IF NOT EXISTS platform_capabilities (
      target TEXT NOT NULL,
      format_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      evidence_test_id TEXT,
      evidence_message_id INTEGER,
      evidence_url TEXT,
      notes TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (target, format_key)
    );

    CREATE TABLE IF NOT EXISTS credential_checks (
      target TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      required_env_json TEXT NOT NULL,
      missing_env_json TEXT NOT NULL,
      expires_at TEXT,
      last_checked_at TEXT NOT NULL,
      next_check_at TEXT,
      last_error TEXT,
      details_json TEXT
    );

    CREATE TABLE IF NOT EXISTS content_memory (
      post_key TEXT PRIMARY KEY,
      message_id INTEGER,
      lang TEXT NOT NULL DEFAULT 'mixed',
      title TEXT,
      summary TEXT,
      topics_json TEXT,
      entities_json TEXT,
      source_urls_json TEXT,
      performance_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analytics_rollups (
      rollup_key TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      subject TEXT NOT NULL,
      metric_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployment_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      git_sha TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      backup_path TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alert_dedup (
      alert_key TEXT PRIMARY KEY,
      last_sent_at TEXT NOT NULL,
      suppressed_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS maintenance_locks (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_test_cases (
      test_id TEXT PRIMARY KEY,
      format_key TEXT NOT NULL,
      title TEXT NOT NULL,
      input_recipe TEXT NOT NULL,
      expected_targets_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      last_message_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_test_results (
      test_id TEXT NOT NULL,
      target TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      external_id TEXT,
      url TEXT,
      error TEXT,
      notes TEXT,
      raw_json TEXT,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (test_id, target, message_id)
    );

    CREATE TABLE IF NOT EXISTS likes (
      post_id TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (post_id, ip_hash)
    );
  `);

  ensureColumn(sqlite, "posts", "post_id", "INTEGER");
  ensureColumn(sqlite, "publications", "draft_id", "INTEGER");
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_draft ON publications(draft_id) WHERE draft_id IS NOT NULL");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_post_targets_target_external ON post_targets(target, external_id)");
}

function ensureColumn(sqlite: SqliteCompat, table: string, column: string, definition: string): void {
  const columns = sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
