import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { editorialTexts, matchEditorialPost } from "./x-post-matching.js";

type CsvRow = Record<string, string>;
type ParsedCsv = { headers: string[]; rows: CsvRow[] };

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
  activityItems: number;
  activitySamples: number;
  importId: number;
  duplicateImport: boolean;
};

/** Imports an X Analytics content export as an immutable snapshot for posts already linked to X. */
export function importXAnalyticsCsv(backendDb: BackendDb, sourcePath: string, sampledAt: string): XCsvImportResult {
  if (Number.isNaN(Date.parse(sampledAt))) throw new Error("--sampled-at must be an ISO timestamp");
  const { headers, rows } = parseCsv(fs.readFileSync(sourcePath, "utf8"));
  if (!rows.length || !rows[0]?.["Идентификатор поста"]) throw new Error("Expected an X Analytics CSV with the column Идентификатор поста");
  // A column this export does not carry is missing data, not a zero. Writing 0
  // for it would overwrite the live post_metrics value — which is what an
  // export in another interface language used to do to every metric at once.
  const presentHeaders = new Set(headers);
  const metrics = METRICS.filter((metric) => presentHeaders.has(metric.column));
  if (!metrics.length) throw new Error("Expected an X Analytics CSV with at least one known metric column");
  const sourceBytes = fs.readFileSync(sourcePath);
  const checksum = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  const existingImport = unsafeDb(backendDb).sqlite.prepare("SELECT id FROM x_activity_imports WHERE checksum=?").get(checksum) as {
    id: number;
  } | null;
  if (existingImport)
    return {
      rows: rows.length,
      matchedPosts: 0,
      linkedByText: 0,
      insertedSamples: 0,
      skippedSamples: 0,
      unmatchedIds: [],
      activityItems: 0,
      activitySamples: 0,
      importId: existingImport.id,
      duplicateImport: true,
    };
  const [periodStart, periodEnd] = exportPeriod(sourcePath);
  const importedAt = new Date().toISOString();
  unsafeDb(backendDb)
    .sqlite.prepare(
      `INSERT OR IGNORE INTO x_activity_imports
       (checksum,source_file,period_start,period_end,sampled_at,imported_at,row_count)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(checksum, path.basename(sourcePath), periodStart, periodEnd, sampledAt, importedAt, rows.length);
  const importRow = unsafeDb(backendDb).sqlite.prepare("SELECT id FROM x_activity_imports WHERE checksum=?").get(checksum) as {
    id: number;
  };
  const targets = unsafeDb(backendDb)
    .sqlite.prepare("SELECT post_key, external_id, external_ids_json FROM post_targets WHERE target='x'")
    .all() as Array<{ post_key: string; external_id: string | null; external_ids_json: string | null }>;
  const postByExternalId = new Map<string, string>();
  const targetIdsByPost = new Map<string, Set<string>>();
  for (const target of targets) {
    const ids = new Set([target.external_id, ...jsonStrings(target.external_ids_json)].filter((id): id is string => Boolean(id)));
    targetIdsByPost.set(target.post_key, ids);
    for (const id of ids) postByExternalId.set(id, target.post_key);
  }
  const postText = editorialTexts(backendDb);
  const imported = unsafeDb(backendDb).sqlite.prepare(
    "SELECT 1 FROM metric_samples WHERE post_key=? AND target='x' AND metric_name=? AND sampled_at=? AND source='x_csv_export' LIMIT 1",
  );
  const insert = unsafeDb(backendDb).sqlite.prepare(
    "INSERT INTO metric_samples (post_key, target, metric_name, value, sampled_at, source) VALUES (?, 'x', ?, ?, ?, 'x_csv_export')",
  );
  const updateCurrent = unsafeDb(backendDb).sqlite.prepare(
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
  const linkTarget = unsafeDb(backendDb).sqlite.prepare(
    `INSERT INTO post_targets (post_key, target, status, external_id, external_ids_json, url, error, skipped, updated_at, raw_json)
     VALUES (?, 'x', 'published', ?, ?, ?, NULL, 0, ?, ?)
     ON CONFLICT(post_key, target) DO UPDATE SET
       status='published', external_id=excluded.external_id, external_ids_json=excluded.external_ids_json,
       url=excluded.url, error=NULL, skipped=0, updated_at=excluded.updated_at, raw_json=excluded.raw_json`,
  );
  const upsertActivity = unsafeDb(backendDb).sqlite.prepare(
    `INSERT INTO x_activity_items
     (x_post_id,kind,published_at,text,url,linked_post_key,first_seen_at,last_seen_at,raw_json)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(x_post_id) DO UPDATE SET
       kind=excluded.kind,
       published_at=coalesce(excluded.published_at,x_activity_items.published_at),
       text=excluded.text,
       url=excluded.url,
       linked_post_key=coalesce(excluded.linked_post_key,x_activity_items.linked_post_key),
       last_seen_at=excluded.last_seen_at,
       raw_json=excluded.raw_json`,
  );
  const insertActivitySample = unsafeDb(backendDb).sqlite.prepare(
    `INSERT OR IGNORE INTO x_activity_metric_snapshots
     (x_post_id,metric_name,value,sampled_at,import_id,raw_json)
     VALUES (?,?,?,?,?,?)`,
  );
  const result: XCsvImportResult = {
    rows: rows.length,
    matchedPosts: 0,
    linkedByText: 0,
    insertedSamples: 0,
    skippedSamples: 0,
    unmatchedIds: [],
    activityItems: 0,
    activitySamples: 0,
    importId: importRow.id,
    duplicateImport: false,
  };
  unsafeDb(backendDb).sqlite.transaction(() => {
    for (const row of rows) {
      const externalId = row["Идентификатор поста"]?.trim();
      if (!externalId) continue;
      let postKey = postByExternalId.get(externalId);
      if (!postKey) {
        const direct = matchEditorialPost(row["Текст поста"], postText);
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
      const text = row["Текст поста"]?.trim() ?? "";
      const url = row["Ссылка на пост"]?.trim() || `https://x.com/i/web/status/${externalId}`;
      upsertActivity.run(
        externalId,
        activityKind(text),
        xPublishedAt(row.Дата),
        text,
        url,
        postKey ?? null,
        sampledAt,
        sampledAt,
        JSON.stringify({ source: "x_csv_export", import_id: importRow.id }),
      );
      result.activityItems += 1;
      for (const metric of metrics) {
        const value = integer(row[metric.column]);
        if (value == null) continue;
        const inserted = insertActivitySample.run(
          externalId,
          metric.name,
          value,
          sampledAt,
          importRow.id,
          JSON.stringify({ x_column: metric.column }),
        );
        result.activitySamples += Number(inserted.changes);
      }
      if (!postKey) {
        result.unmatchedIds.push(externalId);
        continue;
      }
      result.matchedPosts += 1;
      for (const metric of metrics) {
        const value = integer(row[metric.column]);
        // Same reasoning as the header filter above, per cell: a blank or
        // unparseable value leaves the existing metric alone.
        if (value == null) {
          result.skippedSamples += 1;
          continue;
        }
        const raw = JSON.stringify({ x_post_id: externalId, x_column: metric.column });
        if (imported.get(postKey, metric.name, sampledAt)) {
          result.skippedSamples += 1;
        } else {
          insert.run(postKey, metric.name, value, sampledAt);
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

function activityKind(text: string): "reply" | "repost" | "standalone" {
  if (/^RT\s+@/iu.test(text)) return "repost";
  return /^@[\p{L}\p{N}_]+/u.test(text) ? "reply" : "standalone";
}

function xPublishedAt(value: string | undefined): string | null {
  const parsed = new Date(value ?? "");
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function exportPeriod(sourcePath: string): [string | null, string | null] {
  const match = path.basename(sourcePath).match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv$/u);
  return [match?.[1] ?? null, match?.[2] ?? null];
}

function jsonStrings(value: string | null): string[] {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  } catch {
    return [];
  }
}

/** null means "this export says nothing about the metric" — never zero. */
function integer(value: string | undefined): number | null {
  const text = (value ?? "").replace(/,/g, "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Minimal RFC 4180 parser: X exports quote text fields with commas and newlines. */
function parseCsv(input: string): ParsedCsv {
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
  if (!headers) return { headers: [], rows: [] };
  return {
    headers,
    rows: data
      .filter((values) => values.some(Boolean))
      .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]))),
  };
}
