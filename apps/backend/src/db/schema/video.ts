import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { autoId, type JsonObject, json, queueAttempts, timestamps } from "./_shared.js";
import { studioMediaAssets } from "./studio.js";

export const videoDrafts = sqliteTable(
  "video_drafts",
  {
    id: autoId(),
    adminId: integer().notNull(),
    label: text().notNull().default(""),
    assetKey: text().notNull(),
    studioMediaAssetId: integer().references(() => studioMediaAssets.id),
    status: text().notNull().default("draft"),
    scheduledAt: text(),
    reminderSentAt: text(),
    retentionUntil: text(),
    controlChatId: integer(),
    controlMessageId: integer(),
    ...timestamps(),
  },
  (table) => [index("idx_video_drafts_status_schedule").on(table.status, table.scheduledAt)],
);

export const videoTargets = sqliteTable(
  "video_targets",
  {
    id: autoId(),
    videoDraftId: integer()
      .notNull()
      .references(() => videoDrafts.id, { onDelete: "cascade" }),
    target: text().notNull(),
    metadataJson: json<JsonObject>().notNull(),
    scheduledAt: text(),
    status: text().notNull().default("draft"),
    deliveryProvider: text().notNull().default("native"),
    providerAccountId: text(),
    providerPostId: text(),
    externalId: text(),
    externalUrl: text(),
    preparedAt: text(),
    publishedAt: text(),
    lastError: text(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("idx_video_targets_draft_target").on(table.videoDraftId, table.target),
    index("idx_video_targets_status_schedule").on(table.status, table.scheduledAt),
  ],
);

export const videoJobs = sqliteTable(
  "video_jobs",
  {
    id: autoId(),
    videoDraftId: integer()
      .notNull()
      .references(() => videoDrafts.id, { onDelete: "cascade" }),
    videoTargetId: integer().references(() => videoTargets.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    runAt: text().notNull(),
    status: text().notNull().default("queued"),
    ...queueAttempts(),
    ...timestamps(),
  },
  (table) => [
    index("idx_video_jobs_due").on(table.status, table.runAt, table.nextAttemptAt),
    index("idx_video_jobs_lock").on(table.status, table.lockedAt),
    uniqueIndex("idx_video_jobs_unique").on(table.videoDraftId, table.videoTargetId, table.kind),
  ],
);

export const videoBotSessions = sqliteTable("video_bot_sessions", {
  adminId: integer().primaryKey(),
  videoDraftId: integer(),
  step: text().notNull(),
  selectedTargetsJson: json<string[]>().notNull().default([]),
  dataJson: json<JsonObject>().notNull().default({}),
  updatedAt: text().notNull(),
});

export const videoMetricSnapshots = sqliteTable(
  "video_metric_snapshots",
  {
    id: autoId(),
    videoTargetId: integer()
      .notNull()
      .references(() => videoTargets.id, { onDelete: "cascade" }),
    platform: text().notNull(),
    metricsJson: json<JsonObject>().notNull(),
    checkpointIndex: integer(),
    sampledAt: text().notNull(),
  },
  (table) => [index("idx_video_metric_snapshots_target_sampled").on(table.videoTargetId, table.sampledAt)],
);

export const videoMetricSchedule = sqliteTable("video_metric_schedule", {
  videoTargetId: integer()
    .primaryKey()
    .references(() => videoTargets.id, { onDelete: "cascade" }),
  checkpointIndex: integer().notNull().default(0),
  nextCheckAt: text().notNull(),
  lastCheckedAt: text(),
  lastError: text(),
  frozenAt: text(),
  updatedAt: text().notNull(),
});

export const socialComments = sqliteTable(
  "social_comments",
  {
    platform: text().notNull(),
    commentId: text().notNull(),
    videoTargetId: integer()
      .notNull()
      .references(() => videoTargets.id, { onDelete: "cascade" }),
    author: text(),
    text: text().notNull(),
    likeCount: integer().notNull().default(0),
    publishedAt: text(),
    fetchedAt: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.platform, table.commentId] }),
    index("idx_social_comments_target").on(table.videoTargetId, table.publishedAt),
  ],
);
