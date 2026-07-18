import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { autoId, type JsonObject, type JsonValue, json, timestamps } from "./_shared.js";

/** Owner-level notification policy. It belongs to Studio, not to any interface. */
export const studioNotificationSettings = sqliteTable("studio_notification_settings", {
  adminId: integer().primaryKey(),
  remindersEnabled: integer().notNull().default(1),
  reminderMinutes: integer().notNull().default(5),
  completionEnabled: integer().notNull().default(1),
  updatedAt: text().notNull(),
});

/** Durable, interface-neutral scheduled notification work. */
export const studioNotificationJobs = sqliteTable(
  "studio_notification_jobs",
  {
    id: autoId(),
    adminId: integer().notNull(),
    ref: text().notNull(),
    kind: text().notNull(),
    runAt: text().notNull(),
    status: text().notNull().default("queued"),
    payloadJson: json<JsonObject>().notNull().default({}),
    ...timestamps(),
  },
  (table) => [
    index("idx_studio_notification_jobs_due").on(table.status, table.runAt),
    uniqueIndex("idx_studio_notification_jobs_ref_kind").on(table.ref, table.kind),
  ],
);

/** Durable interface-neutral files. Telegram file ids are only one possible source. */
export const studioMediaAssets = sqliteTable(
  "studio_media_assets",
  {
    id: autoId(),
    adminId: integer().notNull(),
    kind: text().notNull(),
    mimeType: text().notNull(),
    filename: text().notNull(),
    localPath: text().notNull(),
    byteSize: integer().notNull(),
    sha256: text().notNull(),
    source: text().notNull(),
    createdAt: text().notNull(),
  },
  (table) => [
    index("idx_studio_media_assets_owner").on(table.adminId, table.createdAt),
    index("idx_studio_media_assets_hash").on(table.sha256),
  ],
);

export const adminState = sqliteTable("admin_state", {
  adminId: integer().primaryKey(),
  action: text(),
  draftId: integer(),
  controlMessageId: integer(),
  updatedAt: text().notNull(),
});

export const botSettings = sqliteTable("bot_settings", {
  adminId: integer().primaryKey(),
  youtubeSignature: text().notNull().default(""),
  pendingAction: text(),
  updatedAt: text().notNull(),
});

export const botUiSettings = sqliteTable("bot_ui_settings", {
  adminId: integer().primaryKey(),
  locale: text().notNull().default("en"),
  updatedAt: text().notNull(),
});

/** Interface-owned presentation references. Domain aggregates never store UI message ids. */
export const interfaceBindings = sqliteTable(
  "interface_bindings",
  {
    interfaceId: text().notNull(),
    entityType: text().notNull(),
    entityId: integer().notNull(),
    conversationId: text().notNull(),
    messageId: text().notNull(),
    stateJson: json<Record<string, JsonValue>>().notNull().default({}),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.interfaceId, table.entityType, table.entityId] }),
    index("idx_interface_bindings_lookup").on(table.entityType, table.entityId),
  ],
);
