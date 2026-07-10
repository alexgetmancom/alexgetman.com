import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";

type ContentRow = {
  post_id: number;
  updated_at: string;
  slug_ru: string | null;
  text_ru: string | null;
  has_ru: number;
  slug_en: string | null;
  text_en: string | null;
  has_en: number;
};

export function publishContentIndex(config: BackendConfig, backendDb: BackendDb): string[] {
  const rows = backendDb.sqlite.prepare(`
    SELECT p.post_id, p.updated_at,
      ru.slug AS slug_ru, ru.text AS text_ru, ru.site_enabled AS has_ru,
      en.slug AS slug_en, en.text AS text_en, en.site_enabled AS has_en
    FROM publications p
    LEFT JOIN post_locales ru ON ru.post_id=p.post_id AND ru.locale='ru'
    LEFT JOIN post_locales en ON en.post_id=p.post_id AND en.locale='en'
    WHERE p.status='published'
    ORDER BY p.post_id DESC LIMIT 200
  `).all() as ContentRow[];
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
  const items = rows.map((row) => ({
    post_id: row.post_id,
    title: firstLine(row.text_en || row.text_ru || "Post"),
    url_ru: row.has_ru && row.slug_ru ? `${base}/ru/${row.post_id}/${row.slug_ru}/` : null,
    url_en: row.has_en && row.slug_en ? `${base}/${row.post_id}/${row.slug_en}/` : null,
    updated_at: row.updated_at,
  }));
  const updatedAt = new Date().toISOString();
  atomicWrite(path.join(config.SITE_PUBLIC_DIR, "content-index.json"), `${JSON.stringify({ updated_at: updatedAt, brand: "alexgetmancom", site: base, items }, null, 2)}\n`);
  const lines = ["# AlexGetman Content Memory", "", `Updated: ${updatedAt}`, ""];
  for (const item of items.slice(0, 80)) {
    lines.push(`## ${item.post_id} - ${item.title}`);
    if (item.url_ru) lines.push(`RU: ${item.url_ru}`);
    if (item.url_en) lines.push(`EN: ${item.url_en}`);
    lines.push("");
  }
  atomicWrite(path.join(config.SITE_PUBLIC_DIR, "content-memory.md"), `${lines.join("\n").trimEnd()}\n`);
  return [
    `${base}/`, `${base}/feed.xml`, `${base}/llms.txt`, `${base}/content-index.json`, `${base}/content-memory.md`,
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
