import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { autoId, type JsonObject, json, queueAttempts, timestamps } from "./_shared.js";

export const publishJobs = sqliteTable(
  "publish_jobs",
  {
    jobId: autoId(),
    postId: integer(),
    postKey: text(),
    messageId: integer().notNull(),
    target: text().notNull(),
    status: text().notNull().default("queued"),
    publishAt: text(),
    payloadJson: json<JsonObject | null>(),
    ...queueAttempts(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("idx_publish_jobs_message_target_status").on(table.messageId, table.target, table.status),
    index("idx_publish_jobs_due").on(table.status, table.publishAt, table.nextAttemptAt, table.createdAt),
    index("idx_publish_jobs_lock").on(table.lockedBy, table.lockedAt),
    index("idx_publish_jobs_post").on(table.postId, table.target, table.status),
  ],
);

export const publishPlans = sqliteTable("publish_plans", {
  messageId: integer().primaryKey(),
  planJson: json<JsonObject>().notNull(),
  ...timestamps(),
});

export const siteSourceItems = sqliteTable("site_source_items", {
  messageId: integer().primaryKey(),
  itemJson: json<JsonObject>().notNull(),
  ...timestamps(),
});

export const publicationPlans = sqliteTable("publication_plans", {
  postId: integer().primaryKey(),
  planJson: json<JsonObject>().notNull(),
  ...timestamps(),
});

export const publicationSources = sqliteTable("publication_sources", {
  postId: integer().primaryKey(),
  itemJson: json<JsonObject>().notNull(),
  ...timestamps(),
});

export const publications = sqliteTable("publications", {
  postId: autoId(),
  draftId: integer(),
  status: text().notNull().default("draft"),
  telegramMessageId: integer(),
  ...timestamps(),
});

export const drafts = sqliteTable("drafts", {
  id: autoId(),
  adminId: integer().notNull(),
  status: text().notNull(),
  textRu: text().notNull(),
  textEnMachine: text(),
  textEnApproved: text(),
  targetsJson: text().notNull(),
  mediaRuJson: text(),
  mediaEnJson: text(),
  channelMessageId: integer(),
  scheduledAt: text(),
  scheduledEnAt: text(),
  publishMode: text(),
  postId: integer(),
  textRuEntitiesJson: text(),
  textEnEntitiesJson: text(),
  ...timestamps(),
});

export const pendingAlbums = sqliteTable("pending_albums", {
  id: text().primaryKey(),
  adminId: integer().notNull(),
  chatId: integer().notNull(),
  mediaGroupId: text().notNull(),
  action: text(),
  draftId: integer(),
  textRu: text().notNull().default(""),
  textEntitiesJson: text(),
  mediaJson: text().notNull(),
  notified: integer().notNull().default(0),
  updatedAt: text().notNull(),
});

export const postControlCards = sqliteTable("post_control_cards", {
  draftId: integer().primaryKey(),
  chatId: integer().notNull(),
  messageId: integer().notNull(),
  updatedAt: text().notNull(),
});
