import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type * as schema from "./schema.js";

/** Drizzle handle shared by persistence adapters without importing the runtime container. */
export type BackendDatabase = BunSQLiteDatabase<typeof schema>;
