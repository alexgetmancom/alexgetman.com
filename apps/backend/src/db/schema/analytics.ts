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
  (table) => [
    index("idx_metric_samples_lookup").on(table.postKey, table.target, table.metricName, table.sampledAt),
    // Retention deletes by age alone. The lookup index above is useless for
    // that predicate — post_key leads it — so the sweep read the whole table.
    index("idx_metric_samples_sampled_at").on(table.sampledAt),
  ],
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

export const xActivityImports = sqliteTable(
  "x_activity_imports",
  {
    id: autoId(),
    checksum: text().notNull(),
    sourceFile: text().notNull(),
    periodStart: text(),
    periodEnd: text(),
    sampledAt: text().notNull(),
    importedAt: text().notNull(),
    rowCount: integer().notNull(),
  },
  (table) => [uniqueIndex("idx_x_activity_imports_checksum").on(table.checksum)],
);

/** Account-wide X activity is deliberately separate from editorial posts.
 * linkedPostKey is optional: replies and posts written directly in X remain
 * analytics-only, while Studio publications can still share one identity. */
export const xActivityItems = sqliteTable(
  "x_activity_items",
  {
    xPostId: text().primaryKey(),
    kind: text().notNull(),
    publishedAt: text(),
    text: text().notNull(),
    url: text().notNull(),
    linkedPostKey: text(),
    firstSeenAt: text().notNull(),
    lastSeenAt: text().notNull(),
    rawJson: json<JsonValue | null>(),
  },
  (table) => [
    index("idx_x_activity_items_published").on(table.publishedAt),
    index("idx_x_activity_items_linked_post").on(table.linkedPostKey),
  ],
);

export const xActivityMetricSnapshots = sqliteTable(
  "x_activity_metric_snapshots",
  {
    id: autoId(),
    xPostId: text().notNull(),
    metricName: text().notNull(),
    value: integer().notNull(),
    sampledAt: text().notNull(),
    importId: integer(),
    rawJson: json<JsonValue | null>(),
  },
  (table) => [
    uniqueIndex("idx_x_activity_metric_snapshot").on(table.xPostId, table.metricName, table.sampledAt),
    index("idx_x_activity_metric_history").on(table.xPostId, table.sampledAt),
  ],
);
