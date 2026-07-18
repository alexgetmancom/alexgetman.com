import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { autoId, type JsonObject, type JsonValue, json } from "./_shared.js";

export const postMetrics = sqliteTable(
  "post_metrics",
  {
    postKey: text().notNull(),
    target: text().notNull(),
    metricName: text().notNull().default("views"),
    value: integer(),
    unit: text().notNull().default("count"),
    source: text(),
    sampledAt: text(),
    error: text(),
    rawJson: json<JsonValue | null>(),
  },
  (table) => [primaryKey({ columns: [table.postKey, table.target, table.metricName] })],
);

export const metricSamples = sqliteTable(
  "metric_samples",
  {
    id: autoId(),
    postKey: text().notNull(),
    target: text().notNull(),
    metricName: text().notNull().default("views"),
    value: integer(),
    sampledAt: text().notNull(),
    source: text(),
    rawJson: json<JsonValue | null>(),
  },
  (table) => [index("idx_metric_samples_lookup").on(table.postKey, table.target, table.metricName, table.sampledAt)],
);

export const metricSchedule = sqliteTable(
  "metric_schedule",
  {
    postKey: text().notNull(),
    target: text().notNull(),
    nextCheckAt: text(),
    lastCheckedAt: text(),
    checkCount: integer().notNull().default(0),
    frozenAt: text(),
    lastError: text(),
    updatedAt: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.postKey, table.target] })],
);

export const analyticsRollups = sqliteTable("analytics_rollups", {
  rollupKey: text().primaryKey(),
  scope: text().notNull(),
  subject: text().notNull(),
  metricJson: text().notNull(),
  updatedAt: text().notNull(),
});

export const analyticsSync = sqliteTable("analytics_sync", {
  source: text().primaryKey(),
  lastSyncedAt: text().notNull(),
  lastSuccessAt: text(),
  lastError: text(),
});

export const creatorProfiles = sqliteTable("creator_profiles", {
  platform: text().primaryKey(),
  dataJson: json<JsonObject>().notNull(),
  updatedAt: text().notNull(),
});

/** Immutable daily audience observations. creatorProfiles remains the latest
 * read model, while this table is the Analytics history. */
export const creatorProfileSnapshots = sqliteTable(
  "creator_profile_snapshots",
  {
    id: autoId(),
    platform: text().notNull(),
    account: text().notNull(),
    sampledOn: text().notNull(),
    metricsJson: json<JsonObject>().notNull(),
    source: text().notNull(),
    sampledAt: text().notNull(),
  },
  (table) => [
    uniqueIndex("idx_creator_profile_snapshots_daily").on(table.platform, table.account, table.sampledOn),
    index("idx_creator_profile_snapshots_history").on(table.platform, table.account, table.sampledAt),
  ],
);
