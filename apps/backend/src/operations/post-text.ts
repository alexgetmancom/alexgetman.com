import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { posts } from "../db/schema.js";
import { resolvePublicationRef } from "./publication-ref.js";

type PostText = { ref: string; postId: number | null; at: string | null; ru: string | null; en: string | null };

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
    .where(eq(posts.postKey, resolved.postKey))
    .get();
  if (!row) throw new Error(`publication ${resolved.postKey} has no stored text`);
  return { ref: resolved.postKey, postId: row.postId, at: row.dateUtc, ru: row.text ?? null, en: row.textEn ?? null };
}

export function formatPostText(value: PostText): string {
  const lines = [`${value.ref}  ${value.at ?? "unscheduled"}`];
  for (const [locale, text] of [
    ["ru", value.ru],
    ["en", value.en],
  ] as const) {
    lines.push("", `--- ${locale} ---`, text?.trim() || "(no text)");
  }
  return lines.join("\n");
}
