import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { firstLine } from "../content/message.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { postLocales, publications } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { atomicWriteText } from "../fsUtils.js";

/** Delivery projection used to materialize the public-site content index. */
export function publishContentIndex(config: BackendConfig, backendDb: BackendDb): string[] {
  const ru = alias(postLocales, "ru");
  const en = alias(postLocales, "en");
  const rows = unsafeDb(backendDb)
    .db.select({
      postId: publications.postId,
      updatedAt: publications.updatedAt,
      slugRu: ru.slug,
      textRu: ru.text,
      hasRu: ru.siteEnabled,
      slugEn: en.slug,
      textEn: en.text,
      hasEn: en.siteEnabled,
    })
    .from(publications)
    .leftJoin(ru, and(eq(ru.postId, publications.postId), eq(ru.locale, "ru")))
    .leftJoin(en, and(eq(en.postId, publications.postId), eq(en.locale, "en")))
    .where(eq(publications.status, "published"))
    .orderBy(desc(publications.postId))
    .limit(200)
    .all();
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
  const items = rows.map((row) => ({
    post_id: row.postId,
    title: firstLine(row.textEn || row.textRu, "Post"),
    url_ru: row.hasRu && row.slugRu ? `${base}/ru/${row.postId}/${row.slugRu}/` : null,
    url_en: row.hasEn && row.slugEn ? `${base}/${row.postId}/${row.slugEn}/` : null,
    updated_at: row.updatedAt,
  }));
  const updatedAt = new Date().toISOString();
  atomicWriteText(
    path.join(config.SITE_PUBLIC_DIR, "content-index.json"),
    `${JSON.stringify({ updated_at: updatedAt, brand: "alexgetmancom", site: base, items }, null, 2)}\n`,
  );
  const lines = ["# AlexGetman Content Memory", "", `Updated: ${updatedAt}`, ""];
  for (const item of items.slice(0, 80)) {
    lines.push(`## ${item.post_id} - ${item.title}`);
    if (item.url_ru) lines.push(`RU: ${item.url_ru}`);
    if (item.url_en) lines.push(`EN: ${item.url_en}`);
    lines.push("");
  }
  atomicWriteText(path.join(config.SITE_PUBLIC_DIR, "content-memory.md"), `${lines.join("\n").trimEnd()}\n`);
  return [
    `${base}/`,
    `${base}/feed.xml`,
    `${base}/llms.txt`,
    `${base}/content-index.json`,
    `${base}/content-memory.md`,
    ...items.flatMap((item) => [item.url_en, item.url_ru]).filter((url): url is string => Boolean(url)),
  ];
}
