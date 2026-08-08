import { type BackendDb, unsafeDb } from "../db/client.js";

export type EditorialText = { post_key: string; text_en: string };

/** X truncates exported post text, so a match is a prefix relation, never
 * equality. Links, whitespace and case carry no identity. */
export function comparableText(value: string | undefined): string {
  return (value ?? "")
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

/** The prefix an import is allowed to act on. Shorter prefixes are reported by
 * the analytics report as candidates, never linked automatically. */
const LINK_PREFIX_LENGTH = 80;

export function editorialTexts(backendDb: BackendDb): EditorialText[] {
  return unsafeDb(backendDb)
    .sqlite.prepare("SELECT post_key, text_en FROM posts WHERE trim(COALESCE(text_en, '')) <> ''")
    .all() as EditorialText[];
}

/** Only a unique, long prefix may create a new association. Quotes and replies
 * intentionally stay unmatched: their text describes the conversation, not
 * necessarily the material being measured. */
export function matchEditorialPost(xText: string | undefined, posts: EditorialText[], minLength = LINK_PREFIX_LENGTH): string | null {
  const source = comparableText(xText);
  if (source.length < minLength) return null;
  const matches = posts.filter((post) => comparableText(post.text_en).startsWith(source));
  return matches.length === 1 ? (matches[0]?.post_key ?? null) : null;
}
