import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.js";

export type BackendDb = {
  sqlite: SqliteCompat;
  db: BunSQLiteDatabase<typeof schema>;
  close: () => void;
};

type MigrationStatus = { hash: string; createdAt: number };

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
  sqlite.backup = async (target: string) => {
    await Bun.write(target, sqlite.serialize());
  };
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run(`PRAGMA busy_timeout = ${timeout}`);
  sqlite.run("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  return {
    sqlite,
    db,
    close: () => sqlite.close(),
  };
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

function drizzleMigrationMetadata(): MigrationStatus[] {
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
