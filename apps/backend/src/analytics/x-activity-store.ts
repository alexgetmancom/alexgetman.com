import { type BackendDb, unsafeDb } from "../db/client.js";

/** Registers a Studio-originated X publication immediately. CSV imports later
 * enrich the same identity with account-wide metrics. */
export function recordPublishedXActivity(
  backendDb: BackendDb,
  input: { publicationKey: string; xPostId: string; url: string | null; publishedAt: string },
): void {
  type CanonicalPost = {
    text_en: string | null;
    text: string | null;
    date_utc: string | null;
  } | null;
  const ref = input.publicationKey.match(/^post:(\d+)$/)?.[1];
  const canonical = ref
    ? (unsafeDb(backendDb)
        .sqlite.prepare(
          `SELECT coalesce(en.approved_text,en.source_text) AS text_en,
                  coalesce(ru.approved_text,ru.source_text) AS text,
                  coalesce(en.published_at,ru.published_at,d.updated_at) AS date_utc
             FROM drafts d
             LEFT JOIN post_locales ru ON ru.draft_id=d.id AND ru.locale='ru'
             LEFT JOIN post_locales en ON en.draft_id=d.id AND en.locale='en'
            WHERE d.post_id=?`,
        )
        .get(Number(ref)) as CanonicalPost)
    : null;
  const text = canonical?.text_en?.trim() || canonical?.text?.trim() || "";
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
      input.publishedAt || canonical?.date_utc,
      text,
      input.url || `https://x.com/i/web/status/${input.xPostId}`,
      input.publicationKey,
      input.publishedAt,
      input.publishedAt,
      JSON.stringify({ source: "studio_publish" }),
    );
}
