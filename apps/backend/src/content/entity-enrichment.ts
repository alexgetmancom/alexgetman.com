import type { BackendDb } from "../db/client.js";

/** Deterministic, non-blocking enrichment for published stories. It only uses
 * a small reviewed catalogue; ambiguous AI guesses never become public links.
 * A focus is deliberately stricter than a mention: only focuses feed hubs. */
export function enrichPublishedPostEntities(backendDb: BackendDb, postId: number): number {
  const locales = backendDb.entityEnrichment.locales(postId);
  const text = locales
    .map((locale) => locale.text ?? "")
    .join("\n")
    .toLocaleLowerCase();
  if (!text.trim()) return 0;
  const headlines = locales.map((locale) => headline(locale.text ?? "")).filter(Boolean);

  const entities = backendDb.entityEnrichment.entities();
  const aliases = backendDb.entityEnrichment.aliases();
  const aliasesByEntity = new Map<number, string[]>();
  for (const alias of aliases) aliasesByEntity.set(alias.entityId, [...(aliasesByEntity.get(alias.entityId) ?? []), alias.alias]);
  const matches = entities.filter(
    (entity) =>
      supportsAutomaticMatching(entity.kind, entity.slug) &&
      entityMatches(text, entity.slug, entity.titleRu, entity.titleEn, aliasesByEntity.get(entity.id) ?? []),
  );
  const focus = new Set<number>();
  const mentions = new Set<number>();
  for (const entity of matches) {
    const isFocus = entityIsFocus(
      entity.kind,
      entity.slug,
      entity.titleRu,
      entity.titleEn,
      aliasesByEntity.get(entity.id) ?? [],
      headlines,
      text,
    );
    (isFocus ? focus : mentions).add(entity.id);
    if (entity.parentEntityId != null) mentions.add(entity.parentEntityId);
  }
  const now = new Date().toISOString();
  for (const entityId of mentions) insertLink(backendDb, postId, entityId, "mention", now);
  for (const entityId of focus) insertLink(backendDb, postId, entityId, "focus", now);
  return new Set([...mentions, ...focus]).size;
}

function insertLink(backendDb: BackendDb, postId: number, entityId: number, linkRole: "focus" | "mention", createdAt: string): void {
  backendDb.entityEnrichment.link(postId, entityId, linkRole, createdAt);
}

function supportsAutomaticMatching(kind: string, slug: string): boolean {
  return kind === "company" || kind === "model" || (kind === "topic" && slug === "codex");
}

function entityIsFocus(
  kind: string,
  slug: string,
  titleRu: string,
  titleEn: string | null,
  aliases: string[],
  headlines: string[],
  text: string,
): boolean {
  if (kind === "topic" && slug === "codex") {
    return (
      headlines.some((value) => containsName(value, "codex")) ||
      /(?:с помощью|через)\s+codex/.test(text) ||
      /\b(?:built|build|created|made|ported|developed)\b[\s\S]{0,80}\b(?:with|using|via)\s+codex/.test(text)
    );
  }
  if (kind !== "model") return false;
  return headlines.some((value) => !isComparisonHeadline(value) && entityMatches(value, slug, titleRu, titleEn, aliases));
}

function headline(value: string): string {
  return (value.split(/\n\s*\n|\r?\n/)[0] ?? "").trim().toLocaleLowerCase();
}

function entityMatches(text: string, slug: string, titleRu: string, titleEn: string | null, aliases: string[] = []): boolean {
  const names = [slug.replaceAll("-", " "), titleRu, titleEn ?? "", ...aliases]
    .map((value) => value.trim().toLocaleLowerCase())
    .filter((value) => value.length >= 3);
  return names.some((name) => containsName(text, name));
}

const namePatterns = new Map<string, RegExp>();

/** Whole-name matching, never a substring: a plain `includes` linked "gpt" from
 * inside "chatgpt" and "meta" from inside "метаданные", and those wrong links
 * are public — they reach the article's JSON-LD `about` block. Boundaries are
 * defined over Unicode letters/digits so Cyrillic titles behave like Latin. */
function containsName(value: string, name: string): boolean {
  const cached = namePatterns.get(name);
  const pattern = cached ?? new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}($|[^\\p{L}\\p{N}])`, "iu");
  if (!cached) namePatterns.set(name, pattern);
  return pattern.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isComparisonHeadline(value: string): boolean {
  return /\b(?:vs|versus|competitor|competes)\b|конкурент|сравнен|против/.test(value);
}
