import { eq } from "drizzle-orm";
import { postLocales } from "../channels/locales.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { posts } from "../db/schema.js";
import { resolvePublicationRef } from "./publication-ref.js";

type PostText = {
  ref: string;
  postId: number | null;
  at: string | null;
  /** The languages this Studio publishes, so an operator reading a publication
   * is not shown an English slot a Studio without English can never fill. */
  locales: string[];
  ru: string | null;
  en: string | null;
};

/** The full copy of one publication, in both languages. `recent` and `find`
 * report a one-line headline, which is enough to recognise a post and not
 * enough to read, review or re-translate it; without this the only route to the
 * text was the production database by hand. */
export function postText(backendDb: BackendDb, ref: string): PostText {
  const resolved = resolvePublicationRef(backendDb, ref);
  if (!resolved) throw new Error(`no publication matches ${ref}`);
  const row = unsafeDb(backendDb)
    .db.select({ postId: posts.postId, dateUtc: posts.dateUtc, text: posts.text, textEn: posts.textEn })
    .from(posts)
    .where(eq(posts.publicationKey, resolved.publicationKey))
    .get();
  if (!row) throw new Error(`publication ${resolved.publicationKey} has no stored text`);
  return {
    ref: resolved.publicationKey,
    postId: row.postId,
    at: row.dateUtc,
    locales: postLocales(backendDb),
    ru: row.text ?? null,
    en: row.textEn ?? null,
  };
}

export function formatPostText(value: PostText): string {
  const lines = [`${value.ref}  ${value.at ?? "unscheduled"}`];
  const texts: Record<string, string | null> = { ru: value.ru, en: value.en };
  if (value.locales.length === 1) {
    lines.push("", texts[value.locales[0] ?? "ru"]?.trim() || "(no text)");
    return lines.join("\n");
  }
  for (const locale of value.locales) lines.push("", `--- ${locale} ---`, texts[locale]?.trim() || "(no text)");
  return lines.join("\n");
}
