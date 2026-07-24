import { and, eq, inArray } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { postLocales, publicationSources, publications } from "../db/schema.js";
import { materializeSiteMedia } from "../delivery/site-media.js";
import type { BackendConfig } from "../foundation/config.js";

type Locale = "ru" | "en";
type Source = Record<string, unknown>;
type ImageWork = { postId: number; locale: Locale; media: Source[]; imageCount: number };

/** Rebuilds archive photos only. Videos deliberately keep their historical
 * files: this backfill exists to add 9:16 still-image composites on VM-106
 * without re-encoding or replacing any old video. */
export async function backfillSiteImageMedia(
  backendDb: BackendDb,
  config: BackendConfig,
  apply: boolean,
  maxUploadKbps?: number,
): Promise<Record<string, unknown>> {
  const rows = backendDb.db
    .select({ postId: publicationSources.postId, itemJson: publicationSources.itemJson, locale: postLocales.locale })
    .from(publicationSources)
    .innerJoin(publications, eq(publications.postId, publicationSources.postId))
    .innerJoin(postLocales, and(eq(postLocales.postId, publicationSources.postId), eq(postLocales.siteEnabled, 1)))
    .where(inArray(publications.status, ["published", "failed"]))
    .all();
  const work: ImageWork[] = rows.flatMap((row): ImageWork[] => {
    const locale = row.locale === "ru" || row.locale === "en" ? row.locale : null;
    if (!locale) return [];
    const media = sourceItems(sourceMedia(row.itemJson as Source, locale));
    const imageCount = media.filter((item) => String(item.type ?? "image").toLowerCase() !== "video").length;
    return imageCount > 0 ? [{ postId: row.postId, locale, media, imageCount }] : [];
  });
  if (!apply)
    return {
      ok: true,
      apply: false,
      posts: new Set(work.map((item) => item.postId)).size,
      locale_projections: work.length,
      images: work.reduce((total, item) => total + item.imageCount, 0),
    };
  if (!maxUploadKbps) throw new Error("site-media-images --apply requires --max-upload-kbps to protect the home VPN link");

  let images = 0;
  for (const item of work) {
    // VM-106 itself is single-lane; sequential submission prevents a long
    // queue from turning a large archive run into request timeouts.
    await materializeSiteMedia(config, item.postId, item.locale, item.media, fetch, { maxUploadKbps, imageOnly: true });
    images += item.imageCount;
  }
  return {
    ok: true,
    apply: true,
    posts: new Set(work.map((item) => item.postId)).size,
    locale_projections: work.length,
    images,
    videos_touched: 0,
    max_upload_kbps: maxUploadKbps,
  };
}

function sourceMedia(source: Source, locale: Locale): unknown {
  if (locale === "ru") return source.media ?? source.media_ru;
  return source.media_en ?? source.media ?? source.media_ru;
}

function sourceItems(raw: unknown): Source[] {
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return items.filter((item): item is Source => Boolean(item) && typeof item === "object");
}
