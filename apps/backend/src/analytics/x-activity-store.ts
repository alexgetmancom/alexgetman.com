import { type BackendDb, unsafeDb } from "../db/client.js";

/** Registers a Studio-originated X publication immediately. CSV imports later
 * enrich the same identity with account-wide metrics. */
export function recordPublishedXActivity(
  backendDb: BackendDb,
  input: { publicationKey: string; xPostId: string; url: string | null; publishedAt: string },
): void {
  const post = unsafeDb(backendDb)
    .sqlite.prepare("SELECT text_en,text,date_utc FROM posts WHERE publication_key=?")
    .get(input.publicationKey) as {
    text_en: string | null;
    text: string | null;
    date_utc: string | null;
  } | null;
  const text = post?.text_en?.trim() || post?.text?.trim() || "";
  unsafeDb(backendDb)
    .sqlite.prepare(
      `INSERT INTO x_activity_items
       (x_post_id,kind,published_at,text,url,linked_publication_key,first_seen_at,last_seen_at,raw_json)
       VALUES (?,'standalone',?,?,?,?,?,?,?)
       ON CONFLICT(x_post_id) DO UPDATE SET
         linked_publication_key=excluded.linked_publication_key,
         published_at=coalesce(x_activity_items.published_at,excluded.published_at),
         text=CASE WHEN x_activity_items.text='' THEN excluded.text ELSE x_activity_items.text END,
         url=excluded.url,
         last_seen_at=excluded.last_seen_at`,
    )
    .run(
      input.xPostId,
      input.publishedAt || post?.date_utc,
      text,
      input.url || `https://x.com/i/web/status/${input.xPostId}`,
      input.publicationKey,
      input.publishedAt,
      input.publishedAt,
      JSON.stringify({ source: "studio_publish" }),
    );
}
