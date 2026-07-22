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
    .prepare("SELECT post_key, external_id FROM post_targets WHERE target='x' AND external_id IS NOT NULL")
    .all() as Array<{ post_key: string; external_id: string }>;
  const postByExternalId = new Map(targets.map((target) => [target.external_id, target.post_key]));
  const imported = backendDb.sqlite.prepare(
    "SELECT 1 FROM metric_samples WHERE post_key=? AND target='x' AND metric_name=? AND sampled_at=? AND source='x_csv_export' LIMIT 1",
  );
  const insert = backendDb.sqlite.prepare(
    "INSERT INTO metric_samples (post_key, target, metric_name, value, sampled_at, source, raw_json) VALUES (?, 'x', ?, ?, ?, 'x_csv_export', ?)",
  );
  const result: XCsvImportResult = { rows: rows.length, matchedPosts: 0, insertedSamples: 0, skippedSamples: 0, unmatchedIds: [] };
  backendDb.sqlite.transaction(() => {
    for (const row of rows) {
      const externalId = row["Идентификатор поста"]?.trim();
      if (!externalId) continue;
      const postKey = postByExternalId.get(externalId);
      if (!postKey) {
        result.unmatchedIds.push(externalId);
        continue;
      }
      result.matchedPosts += 1;
      for (const metric of METRICS) {
        if (imported.get(postKey, metric.name, sampledAt)) {
          result.skippedSamples += 1;
          continue;
        }
        insert.run(
          postKey,
          metric.name,
          integer(row[metric.column]),
          sampledAt,
          JSON.stringify({ x_post_id: externalId, x_column: metric.column }),
        );
        result.insertedSamples += 1;
      }
    }
  })();
  return result;
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
