import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, type MediaPayload, timestamps } from "./_shared.js";

export const posts = sqliteTable(
  "posts",
  {
    publicationKey: text().primaryKey(),
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
    siteRuPath: text(),
    siteEnPath: text(),
    telegramUrl: text(),
    status: text().notNull().default("active"),
    ...timestamps(),
    rawJson: text(),
  },
  (table) => [index("idx_posts_updated_at").on(table.updatedAt)],
);

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

export const publicationTargets = sqliteTable(
  "publication_targets",
  {
    publicationKey: text().notNull(),
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
  (table) => [
    primaryKey({ columns: [table.publicationKey, table.target] }),
    index("idx_publication_targets_updated_at").on(table.updatedAt),
  ],
);
