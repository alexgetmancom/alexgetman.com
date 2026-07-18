import { integer, text } from "drizzle-orm/sqlite-core";

export type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, unknown>;
export type MediaPayload = Record<string, unknown>;

/** Every column helper is a factory: builders must never be shared between tables. */
export const autoId = () => integer().primaryKey({ autoIncrement: true });

export const json = <T>() => text({ mode: "json" }).$type<T>();

export const timestamps = () => ({
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});

/** Retry/lock bookkeeping shared by the queue tables. */
export const queueAttempts = () => ({
  attemptCount: integer().notNull().default(0),
  nextAttemptAt: text(),
  lockedBy: text(),
  lockedAt: text(),
  lastError: text(),
});
