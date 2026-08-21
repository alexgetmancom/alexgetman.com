import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { autoId, timestamps } from "./_shared.js";

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
    kind: text().notNull(), // company, model, person, topic; product is legacy only
    parentEntityId: integer(),
    slug: text().notNull(),
    titleRu: text().notNull(),
    titleEn: text(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("idx_knowledge_entities_kind_slug").on(table.kind, table.slug),
    index("idx_knowledge_entities_kind").on(table.kind),
    index("idx_knowledge_entities_parent").on(table.parentEntityId),
  ],
);

/** Alias matching prevents one model being silently split into several spellings. */
export const knowledgeEntityAliases = sqliteTable(
  "knowledge_entity_aliases",
  {
    entityId: integer().notNull(),
    alias: text().notNull(),
    createdAt: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.entityId, table.alias] })],
);

/** A story can be connected to multiple companies, models and themes. Keyed by
 * the draft, like every other child of the aggregate: the accepted candidates
 * this grows out of are keyed that way too. */
export const draftEntityLinks = sqliteTable(
  "draft_entity_links",
  {
    draftId: integer().notNull(),
    entityId: integer().notNull(),
    /** A focus drives a hub's main timeline; a mention remains available for
     * related pages and editorial research without polluting that timeline. */
    linkRole: text().notNull().default("mention"), // focus | mention
    createdAt: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.entityId] }),
    index("idx_draft_entity_links_entity").on(table.entityId, table.draftId),
  ],
);
