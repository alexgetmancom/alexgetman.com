import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { autoId, json, type MediaPayload, timestamps } from "./_shared.js";

/** Long-form publications. An article is not a post with a longer body: its
 * title is a field rather than something derived from the first line, and it
 * reaches destinations that only carry long form (the site, X Articles). It
 * rides the same delivery spine as every other publication -- `publish_jobs`
 * and `publication_targets`, keyed by `article:{id}`. */
export const articles = sqliteTable(
  "articles",
  {
    id: autoId(),
    actorId: integer().notNull(),
    status: text().notNull().default("draft"),
    ...timestamps(),
  },
  (table) => [index("idx_articles_status").on(table.status, table.updatedAt)],
);

/** Body per language, in the representation every target already reads:
 * plain text plus offset/length entities. Delivery renders it into HTML for
 * the site and into `content_state` for X, so no target owns the source form. */
export const articleLocales = sqliteTable(
  "article_locales",
  {
    articleId: integer().notNull(),
    locale: text().notNull(),
    slug: text().notNull(),
    title: text().notNull().default(""),
    bodyText: text(),
    entitiesJson: text(),
    mediaJson: json<MediaPayload[] | null>(),
    publishedAt: text(),
    updatedAt: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.articleId, table.locale] })],
);
