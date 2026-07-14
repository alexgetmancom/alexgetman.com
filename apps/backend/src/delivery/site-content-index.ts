import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { postLocales, publications } from "../db/schema.js";

/** Delivery projection used to materialize the public-site content index. */
export function publishContentIndex(config: BackendConfig, backendDb: BackendDb): string[] {
  const ru = alias(postLocales, "ru");
  const en = alias(postLocales, "en");
  const rows = backendDb.db
    .select({
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
    title: firstLine(row.textEn || row.textRu || "Post"),
    url_ru: row.hasRu && row.slugRu ? `${base}/ru/${row.postId}/${row.slugRu}/` : null,
    url_en: row.hasEn && row.slugEn ? `${base}/${row.postId}/${row.slugEn}/` : null,
    updated_at: row.updatedAt,
  }));
  const updatedAt = new Date().toISOString();
  atomicWrite(
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
  atomicWrite(path.join(config.SITE_PUBLIC_DIR, "content-memory.md"), `${lines.join("\n").trimEnd()}\n`);
  return [
    `${base}/`,
    `${base}/feed.xml`,
    `${base}/llms.txt`,
    `${base}/content-index.json`,
    `${base}/content-memory.md`,
    ...items.flatMap((item) => [item.url_en, item.url_ru]).filter((url): url is string => Boolean(url)),
  ];
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || "Post";
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o664 });
  fs.renameSync(temp, filePath);
}
