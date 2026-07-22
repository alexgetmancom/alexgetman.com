import fs from "node:fs";
import type { BackendDb } from "../db/client.js";

type CsvRow = Record<string, string>;

const METRICS: Array<{ column: string; name: string }> = [
  { column: "Показы", name: "views" },
  { column: "Нравится", name: "likes" },
  { column: "Взаимодействия", name: "interactions" },
  { column: "Закладки", name: "saves" },
  { column: "Поделились", name: "shares" },
  { column: "Новые читатели", name: "follows" },
  { column: "Ответы", name: "replies" },
  { column: "Репосты", name: "reposts" },
  { column: "Посещения профиля", name: "profile_visits" },
  { column: "Разворачивания подробных сведений", name: "detail_expands" },
  { column: "Клики по URL-адресам", name: "link_clicks" },
  { column: "Клики по хештегам", name: "hashtag_clicks" },
  { column: "Клики по постоянным ссылкам", name: "permalink_clicks" },
];

export type XCsvImportResult = {
  rows: number;
  matchedPosts: number;
  linkedByText: number;
  insertedSamples: number;
  skippedSamples: number;
  unmatchedIds: string[];
};

/** Imports an X Analytics content export as an immutable snapshot for posts already linked to X. */
export function importXAnalyticsCsv(backendDb: BackendDb, sourcePath: string, sampledAt: string): XCsvImportResult {
  if (Number.isNaN(Date.parse(sampledAt))) throw new Error("--sampled-at must be an ISO timestamp");
  const rows = parseCsv(fs.readFileSync(sourcePath, "utf8"));
  if (!rows.length || !rows[0]?.["Идентификатор поста"]) throw new Error("Expected an X Analytics CSV with the column Идентификатор поста");
  const targets = backendDb.sqlite
    .prepare("SELECT post_key, external_id, external_ids_json FROM post_targets WHERE target='x'")
    .all() as Array<{ post_key: string; external_id: string | null; external_ids_json: string | null }>;
  const postByExternalId = new Map<string, string>();
  const targetIdsByPost = new Map<string, Set<string>>();
  for (const target of targets) {
    const ids = new Set([target.external_id, ...jsonStrings(target.external_ids_json)].filter((id): id is string => Boolean(id)));
    targetIdsByPost.set(target.post_key, ids);
    for (const id of ids) postByExternalId.set(id, target.post_key);
  }
  const postText = backendDb.sqlite.prepare("SELECT post_key, text_en FROM posts WHERE trim(COALESCE(text_en, '')) <> ''").all() as Array<{
    post_key: string;
    text_en: string;
  }>;
  const imported = backendDb.sqlite.prepare(
    "SELECT 1 FROM metric_samples WHERE post_key=? AND target='x' AND metric_name=? AND sampled_at=? AND source='x_csv_export' LIMIT 1",
  );
  const insert = backendDb.sqlite.prepare(
    "INSERT INTO metric_samples (post_key, target, metric_name, value, sampled_at, source, raw_json) VALUES (?, 'x', ?, ?, ?, 'x_csv_export', ?)",
  );
  const updateCurrent = backendDb.sqlite.prepare(
    `INSERT INTO post_metrics (post_key, target, metric_name, value, unit, source, sampled_at, error, raw_json)
     VALUES (?, 'x', ?, ?, 'count', 'x_csv_export', ?, NULL, ?)
     ON CONFLICT(post_key, target, metric_name) DO UPDATE SET
       value=excluded.value,
       unit=excluded.unit,
       source=excluded.source,
       sampled_at=excluded.sampled_at,
       error=NULL,
       raw_json=excluded.raw_json`,
  );
  const linkTarget = backendDb.sqlite.prepare(
    `INSERT INTO post_targets (post_key, target, status, external_id, external_ids_json, url, error, skipped, updated_at, raw_json)
     VALUES (?, 'x', 'published', ?, ?, ?, NULL, 0, ?, ?)
     ON CONFLICT(post_key, target) DO UPDATE SET
       status='published', external_id=excluded.external_id, external_ids_json=excluded.external_ids_json,
       url=excluded.url, error=NULL, skipped=0, updated_at=excluded.updated_at, raw_json=excluded.raw_json`,
  );
  const result: XCsvImportResult = {
    rows: rows.length,
    matchedPosts: 0,
    linkedByText: 0,
    insertedSamples: 0,
    skippedSamples: 0,
    unmatchedIds: [],
  };
  backendDb.sqlite.transaction(() => {
    for (const row of rows) {
      const externalId = row["Идентификатор поста"]?.trim();
      if (!externalId) continue;
      let postKey = postByExternalId.get(externalId);
      if (!postKey) {
        const direct = uniqueDirectPost(row["Текст поста"], postText);
        if (direct) {
          postKey = direct;
          const ids = targetIdsByPost.get(postKey) ?? new Set<string>();
          ids.add(externalId);
          targetIdsByPost.set(postKey, ids);
          linkTarget.run(
            postKey,
            externalId,
            JSON.stringify([...ids]),
            `https://x.com/i/web/status/${externalId}`,
            new Date().toISOString(),
            JSON.stringify({ source: "x_csv_export", x_post_id: externalId, matched_by: "direct_text" }),
          );
          postByExternalId.set(externalId, postKey);
          result.linkedByText += 1;
        }
      }
      if (!postKey) {
        result.unmatchedIds.push(externalId);
        continue;
      }
      result.matchedPosts += 1;
      for (const metric of METRICS) {
        const value = integer(row[metric.column]);
        const raw = JSON.stringify({ x_post_id: externalId, x_column: metric.column });
        if (imported.get(postKey, metric.name, sampledAt)) {
          result.skippedSamples += 1;
        } else {
          insert.run(postKey, metric.name, value, sampledAt, raw);
          result.insertedSamples += 1;
        }
        // Command Center renders its current values from post_metrics, while
        // reports consume the immutable metric_samples history above.
        updateCurrent.run(postKey, metric.name, value, sampledAt, raw);
      }
    }
  })();
  return result;
}

function jsonStrings(value: string | null): string[] {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  } catch {
    return [];
  }
}

/** X truncates exported post text, so only a unique, long prefix may create a
 * new association. Quotes/replies intentionally stay unmatched: their text
 * describes the conversation, not necessarily the material being measured. */
function uniqueDirectPost(xText: string | undefined, posts: Array<{ post_key: string; text_en: string }>): string | null {
  const source = comparableText(xText);
  if (source.length < 80) return null;
  const matches = posts.filter((post) => comparableText(post.text_en).startsWith(source));
  return matches.length === 1 ? (matches[0]?.post_key ?? null) : null;
}

function comparableText(value: string | undefined): string {
  return (value ?? "")
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function integer(value: string | undefined): number {
  const parsed = Number((value ?? "0").replace(/,/g, "").trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Minimal RFC 4180 parser: X exports quote text fields with commas and newlines. */
function parseCsv(input: string): CsvRow[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if (field || record.length) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  const [headers, ...data] = records;
  return headers
    ? data
        .filter((values) => values.some(Boolean))
        .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])))
    : [];
}
