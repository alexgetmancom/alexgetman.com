import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { ApplicationPorts } from "../application/ports.js";
import { queueDraftStoryCards } from "../story-cards/store.js";
import { createChannelStore } from "./repositories/channels.js";
import { createDraftStore } from "./repositories/drafts.js";
import { createEntityEnrichmentStore } from "./repositories/entity-enrichment.js";
import { createEventStore } from "./repositories/events.js";
import { createStudioMediaAssetStore } from "./repositories/studio-media-assets.js";
import { createStudioNotificationStore } from "./repositories/studio-notifications.js";
import { createStudioPostAdminStateStore } from "./repositories/studio-post-admin-state.js";
import { createStudioPostStore } from "./repositories/studio-posts.js";
import { createStudioQueueStore } from "./repositories/studio-queue.js";
import { createStudioSettingsStore } from "./repositories/studio-settings.js";
import { createStudioVideoStore } from "./repositories/studio-videos.js";
import * as schema from "./schema.js";
import type { RawBackendDb, RawSqlite } from "./unsafe.js";

export { unsafeDb } from "./unsafe.js";

/** Public runtime handle exposed to application services and interfaces. */
export type BackendDb = ApplicationPorts & {
  close: () => void;
};

/**
 * Explicit escape hatch for infrastructure code that still needs raw SQLite.
 * Keep this type out of Studio and Content application services.
 */
export type UnsafeBackendDb = BackendDb & {
  sqlite: RawBackendDb["sqlite"];
  db: RawBackendDb["db"];
};

type MigrationStatus = { hash: string; createdAt: number };

type SqliteCompat = RawSqlite;

export function openBackendDb(path: string, timeout = 30_000): BackendDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path, { create: true, strict: true }) as SqliteCompat;
  sqlite.backup = async (target: string) => {
    // serialize() only snapshots the main .db file; in WAL mode, recently
    // committed data can still be sitting in .db-wal and would be silently
    // missing from the backup. VACUUM INTO merges the WAL first and writes
    // a single consistent file — the target must not already exist.
    if (existsSync(target)) unlinkSync(target);
    sqlite.run("VACUUM INTO ?", [target]);
  };
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run(`PRAGMA busy_timeout = ${timeout}`);
  const db = drizzle(sqlite, { schema, casing: "snake_case" });
  // Migrations run with foreign keys OFF and the pragma is turned on only after.
  // The table-rebuild migrations (0008 and later) drop a parent table while the
  // not-yet-rebuilt children still reference it; with enforcement on, that DROP
  // runs an implicit DELETE and fails on the first child row. An empty database
  // hides this — it only bites when migrating a restored dump that has data.
  sqlite.run("PRAGMA foreign_keys = OFF");
  migrate(db, { migrationsFolder: migrationsFolder() });
  sqlite.run("PRAGMA foreign_keys = ON");
  const clock = { now: () => new Date() };
  let backendDb: UnsafeBackendDb;
  backendDb = {
    sqlite,
    db,
    clock,
    drafts: createDraftStore(db, clock),
    events: createEventStore(db, clock),
    entityEnrichment: createEntityEnrichmentStore(db),
    channels: createChannelStore(db),
    studioNotifications: createStudioNotificationStore(db),
    studioSettings: createStudioSettingsStore(db),
    studioMediaAssets: createStudioMediaAssetStore(db),
    studioPosts: createStudioPostStore(db),
    studioPostAdminState: createStudioPostAdminStateStore(db),
    studioQueue: createStudioQueueStore(db),
    studioVideos: createStudioVideoStore(db),
    storyCards: { queue: (draftId) => queueDraftStoryCards(backendDb, draftId) },
    close: () => sqlite.close(),
  };
  return backendDb;
}

export function migrationStatus(sqlite: SqliteCompat): MigrationStatus[] {
  return sqlite.prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all() as MigrationStatus[];
}

export function baselineDrizzleMigrations(sqlite: SqliteCompat): MigrationStatus[] {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
    name: string;
  }>;
  const names = new Set(tables.map((table) => table.name));
  const missing = ["publish_jobs", "drafts", "publications", "posts", "post_targets", "site_jobs"].filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`baseline requires a complete legacy database; missing: ${missing.join(", ")}`);
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)",
  );
  if (migrationStatus(sqlite).length > 0) return migrationStatus(sqlite);
  const migrations = drizzleMigrationMetadata();
  // Only the legacy snapshot is baselined. Every migration added afterwards is
  // intentionally applied by Drizzle, including when this command is rerun.
  const baseline = migrations.slice(0, 1);
  sqlite.transaction(() => {
    const insert = sqlite.prepare("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)");
    for (const migration of baseline) insert.run(migration.hash, migration.createdAt);
  })();
  return migrationStatus(sqlite);
}

function migrationsFolder(): string {
  return process.env.DRIZZLE_MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
}

/** Hash + timestamp of every migration on disk, in journal order. This is the
 * expected end state of `__drizzle_migrations` once a database is fully
 * migrated, so tests assert against it instead of a hand-maintained count. */
export function drizzleMigrationMetadata(): MigrationStatus[] {
  const folder = migrationsFolder();
  const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  return journal.entries.map((entry) => ({
    hash: crypto
      .createHash("sha256")
      .update(readFileSync(join(folder, `${entry.tag}.sql`), "utf8"))
      .digest("hex"),
    createdAt: entry.when,
  }));
}
