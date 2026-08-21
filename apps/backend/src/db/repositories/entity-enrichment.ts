import { and, eq, inArray, sql } from "drizzle-orm";
import type { EntityEnrichmentStore } from "../../application/ports.js";
import { draftEntityLinks, knowledgeEntities, knowledgeEntityAliases, postLocales } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite adapter for the reviewed catalogue used by deterministic enrichment. */
export function createEntityEnrichmentStore(db: BackendDatabase): EntityEnrichmentStore {
  return {
    locales(draftId) {
      return db
        .select({ locale: postLocales.locale, text: sql<string>`coalesce(${postLocales.approvedText}, ${postLocales.sourceText}, '')` })
        .from(postLocales)
        .where(and(eq(postLocales.draftId, draftId), inArray(postLocales.locale, ["ru", "en"])))
        .all();
    },

    entities() {
      return db
        .select({
          id: knowledgeEntities.id,
          kind: knowledgeEntities.kind,
          parentEntityId: knowledgeEntities.parentEntityId,
          slug: knowledgeEntities.slug,
          titleRu: knowledgeEntities.titleRu,
          titleEn: knowledgeEntities.titleEn,
        })
        .from(knowledgeEntities)
        .where(inArray(knowledgeEntities.kind, ["company", "model", "topic"]))
        .all();
    },

    aliases() {
      return db
        .select({ entityId: knowledgeEntityAliases.entityId, alias: knowledgeEntityAliases.alias })
        .from(knowledgeEntityAliases)
        .all();
    },

    link(draftId, entityId, linkRole, createdAt) {
      db.insert(draftEntityLinks)
        .values({ draftId, entityId, linkRole, createdAt })
        .onConflictDoUpdate({ target: [draftEntityLinks.draftId, draftEntityLinks.entityId], set: { linkRole } })
        .run();
    },
  };
}
