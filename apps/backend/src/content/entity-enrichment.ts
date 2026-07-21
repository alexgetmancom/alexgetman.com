import { and, eq, inArray } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { knowledgeEntities, postEntityLinks, postLocales } from "../db/schema.js";

/** Deterministic, non-blocking enrichment for published stories. It only uses
 * a small reviewed canonical catalogue; ambiguous AI guesses never become
 * public links. A matched model also carries its parent company. */
export function enrichPublishedPostEntities(backendDb: BackendDb, postId: number): number {
  const locales = backendDb.db
    .select({ text: postLocales.text })
    .from(postLocales)
    .where(and(eq(postLocales.postId, postId), inArray(postLocales.locale, ["ru", "en"])))
    .all();
  const text = locales
    .map((locale) => locale.text ?? "")
    .join("\n")
    .toLocaleLowerCase();
  if (!text.trim()) return 0;

  const entities = backendDb.db
    .select()
    .from(knowledgeEntities)
    .where(inArray(knowledgeEntities.kind, ["company", "model"]))
    .all();
  const matches = entities.filter((entity) => entityMatches(text, entity.slug, entity.titleRu, entity.titleEn));
  const ids = new Set<number>();
  for (const entity of matches) {
    ids.add(entity.id);
    if (entity.parentEntityId != null) ids.add(entity.parentEntityId);
  }
  const now = new Date().toISOString();
  for (const entityId of ids) backendDb.db.insert(postEntityLinks).values({ postId, entityId, createdAt: now }).onConflictDoNothing().run();
  return ids.size;
}

function entityMatches(text: string, slug: string, titleRu: string, titleEn: string | null): boolean {
  const names = [slug.replaceAll("-", " "), titleRu, titleEn ?? ""]
    .map((value) => value.trim().toLocaleLowerCase())
    .filter((value) => value.length >= 3);
  return names.some((name) => text.includes(name));
}
