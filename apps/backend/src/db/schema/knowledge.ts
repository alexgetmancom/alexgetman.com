import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { autoId, timestamps } from "./_shared.js";

/** Public evidence attached to a published story. A source is deliberately
 * independent from its platform: an official announcement can live on a web
 * site, X, GitHub, or elsewhere. */
export const postSources = sqliteTable(
  "post_sources",
  {
    id: autoId(),
    postId: integer().notNull(),
    url: text().notNull(),
    labelRu: text().notNull(),
    labelEn: text(),
    displayKind: text(), // "official", "opinion", or null for an ordinary source
    publishedAt: text(),
    sortOrder: integer().notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("idx_post_sources_post_url").on(table.postId, table.url),
    index("idx_post_sources_post_order").on(table.postId, table.sortOrder),
  ],
);

/** Sources are collected while a story is still a draft, then copied to its
 * durable post at publication time. This keeps the Telegram editor fast and
 * makes scheduled posts reproducible. */
export const draftSources = sqliteTable(
  "draft_sources",
  {
    id: autoId(),
    draftId: integer().notNull(),
    url: text().notNull(),
    labelRu: text().notNull(),
    labelEn: text(),
    displayKind: text(),
    sortOrder: integer().notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("idx_draft_sources_draft_url").on(table.draftId, table.url),
    index("idx_draft_sources_draft_order").on(table.draftId, table.sortOrder),
  ],
);

/** Model suggestions remain private until the editor accepts them. */
export const draftEntityCandidates = sqliteTable(
  "draft_entity_candidates",
  {
    id: autoId(),
    draftId: integer().notNull(),
    kind: text().notNull(),
    slug: text().notNull(),
    titleRu: text().notNull(),
    titleEn: text(),
    status: text().notNull().default("suggested"), // suggested, accepted, dismissed
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("idx_draft_entity_candidates_unique").on(table.draftId, table.kind, table.slug),
    index("idx_draft_entity_candidates_draft_status").on(table.draftId, table.status),
  ],
);

/** Canonical, reusable objects for the site memory. Only entities with enough
 * human-reviewed material will later receive public hub pages. */
export const knowledgeEntities = sqliteTable(
  "knowledge_entities",
  {
    id: autoId(),
    kind: text().notNull(), // company, model, person, topic
    slug: text().notNull(),
    titleRu: text().notNull(),
    titleEn: text(),
    summaryRu: text(),
    summaryEn: text(),
    editorialUpdatedAt: text(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("idx_knowledge_entities_kind_slug").on(table.kind, table.slug),
    index("idx_knowledge_entities_kind").on(table.kind),
  ],
);

/** Alias matching prevents one model being silently split into several spellings. */
export const knowledgeEntityAliases = sqliteTable(
  "knowledge_entity_aliases",
  {
    entityId: integer().notNull(),
    alias: text().notNull(),
    normalizedAlias: text().notNull(),
    createdAt: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entityId, table.alias] }),
    uniqueIndex("idx_knowledge_entity_aliases_normalized").on(table.normalizedAlias),
  ],
);

/** A story can be connected to multiple companies, models and themes. */
export const postEntityLinks = sqliteTable(
  "post_entity_links",
  {
    postId: integer().notNull(),
    entityId: integer().notNull(),
    createdAt: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.entityId] }),
    index("idx_post_entity_links_entity").on(table.entityId, table.postId),
  ],
);
