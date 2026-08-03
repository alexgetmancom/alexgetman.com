import type { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type * as schema from "./schema.js";

export type RawSqlite = Omit<Database, "prepare" | "query"> & {
  prepare: (sql: string) => any;
  query: (sql: string) => any;
  backup: (target: string) => Promise<void>;
};

export type RawBackendDb = {
  sqlite: RawSqlite;
  db: BunSQLiteDatabase<typeof schema>;
};

/** Explicit escape hatch for infrastructure and diagnostic code. */
export function unsafeDb(backendDb: object): RawBackendDb {
  return backendDb as RawBackendDb;
}
