import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { type JsonObject, json } from "./_shared.js";

/** One durable conversation row per actor and bot workflow. */
export const conversationSessions = sqliteTable(
  "conversation_sessions",
  {
    actorId: integer().notNull(),
    kind: text().notNull(),
    draftId: integer(),
    step: text(),
    selectedTargetsJson: json<string[]>().notNull().default([]),
    dataJson: json<JsonObject>().notNull().default({}),
    controlMessageId: integer(),
    revision: integer().notNull().default(0),
    active: integer().notNull().default(1),
    updatedAt: text().notNull(),
    expiresAt: text(),
  },
  (table) => [
    primaryKey({ columns: [table.actorId, table.kind] }),
    index("idx_conversation_sessions_expiry").on(table.active, table.expiresAt),
  ],
);
