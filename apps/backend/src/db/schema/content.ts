import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, type MediaPayload, timestamps } from "./_shared.js";

export const posts = sqliteTable("posts", {
  postKey: text().primaryKey(),
  postId: integer(),
  source: text().notNull().default("studio"),
  channel: text().notNull(),
  chatId: text(),
  messageId: integer().notNull(),
  dateUtc: text(),
  dateMsk: text(),
  text: text(),
  textEn: text(),
  html: text(),
  htmlEn: text(),
  mediaJson: text(),
  mediaCount: integer().notNull().default(0),
  mediaTypesJson: text(),
  siteRuPath: text(),
  siteEnPath: text(),
  telegramUrl: text(),
  status: text().notNull().default("active"),
  ...timestamps(),
  rawJson: text(),
});

export const postLocales = sqliteTable(
  "post_locales",
  {
    postId: integer().notNull(),
    locale: text().notNull(),
    slug: text().notNull(),
    text: text(),
    html: text(),
    entitiesJson: text(),
    mediaJson: json<MediaPayload[] | null>(),
    siteEnabled: integer().notNull().default(0),
    publishedAt: text(),
    updatedAt: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.postId, table.locale] })],
);

export const postTargets = sqliteTable(
  "post_targets",
  {
    postKey: text().notNull(),
    target: text().notNull(),
    status: text().notNull().default("unknown"),
    externalId: text(),
    externalIdsJson: json<string[] | null>(),
    url: text(),
    error: text(),
    skipped: integer().notNull().default(0),
    publishedAt: text(),
    confirmationSource: text(),
    verifiedAt: text(),
    updatedAt: text().notNull(),
    rawJson: text(),
  },
  (table) => [primaryKey({ columns: [table.postKey, table.target] })],
);

export const postLifecycle = sqliteTable("post_lifecycle", {
  postKey: text().primaryKey(),
  state: text().notNull(),
  previousState: text(),
  enteredAt: text().notNull(),
  updatedAt: text().notNull(),
  reason: text(),
  rawJson: text(),
});
