import { existsSync, unlinkSync } from "node:fs";
import { parsePublicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { postDraftReferencesAsset } from "../delivery/video-retention.js";
import { resolvePublicationRef } from "./publication-ref.js";

type PurgeInput = { ref: string; apply: boolean };
type SqlArgs = Array<string | number>;
type PurgeStatement = { name: string; countSql: string; deleteSql: string; args: SqlArgs };
type TargetState = { target: string; status: string; url: string | null };

export async function purgePublication(backendDb: BackendDb, input: PurgeInput, fetchImpl: typeof fetch) {
  const parsed = parsePublicationRef(input.ref);
  if (parsed?.kind === "video") return purgeVideoPublication(backendDb, parsed.id, input.apply, fetchImpl);
  const resolved = resolvePublicationRef(backendDb, input.ref);
  if (!resolved?.postId) throw new Error(`publication not found: ${input.ref}`);
  const sqlite = unsafeDb(backendDb).sqlite;
  const publication = sqlite.query("SELECT draft_id AS draftId FROM publications WHERE post_id=?").get(resolved.postId) as {
    draftId: number | null;
  } | null;
  if (!publication?.draftId) throw new Error(`purge requires a Studio publication: ${resolved.postKey}`);
  const draftId = publication.draftId;
  const postId = resolved.postId;
  const refs = [`post:${postId}`, `draft:${draftId}`];
  const statements = purgeStatements(postId, draftId, resolved.postKey, resolved.messageId, refs);
  const rows = Object.fromEntries(
    statements
      .map((statement) => [statement.name, count(sqlite.query(statement.countSql).get(...statement.args))] as const)
      .filter(([, value]) => value > 0),
  );
  const files = (
    sqlite
      .query(
        "SELECT local_path AS path FROM draft_story_cards WHERE draft_id=? AND local_path IS NOT NULL UNION SELECT site_ru_path AS path FROM posts WHERE post_key=? AND site_ru_path IS NOT NULL UNION SELECT site_en_path AS path FROM posts WHERE post_key=? AND site_en_path IS NOT NULL",
      )
      .all(draftId, resolved.postKey, resolved.postKey) as Array<{ path: string }>
  ).map(({ path }) => path);
  if (!input.apply) return { ok: true, applied: false, action: "purge", ref: resolved.postKey, draft_id: draftId, rows, files };

  const verified = await assertPublicationAbsent(sqlite, resolved.postKey, fetchImpl);
  const deleted = sqlite
    .transaction(() => {
      // The proof that nothing is live was gathered over HTTP and cannot travel
      // in a WHERE clause, so it travels as this: the delete only proceeds
      // while the targets still look exactly as they did when they were
      // checked. A worker that published one in between rolls the whole purge
      // back rather than erasing the record of a post that just went out.
      if (targetSignature(targetStates(sqlite, resolved.postKey)) !== targetSignature(verified))
        throw new Error(`targets for ${resolved.postKey} changed while it was being verified; nothing was deleted`);
      const result: Record<string, number> = {};
      for (const statement of statements) {
        const changes = sqlite.query(statement.deleteSql).run(...statement.args).changes;
        if (changes > 0) result[statement.name] = changes;
      }
      const remaining = sqlite.query("SELECT COUNT(*) AS count FROM publications WHERE post_id=? OR draft_id=?").get(postId, draftId);
      if (count(remaining) !== 0) throw new Error(`purge did not remove ${resolved.postKey}`);
      return result;
    })
    .immediate();
  const removedFiles: string[] = [];
  const failedFiles: string[] = [];
  for (const path of files) {
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
      removedFiles.push(path);
    } catch {
      failedFiles.push(path);
    }
  }
  return {
    ok: failedFiles.length === 0,
    applied: true,
    action: "purge",
    ref: resolved.postKey,
    draft_id: draftId,
    deleted,
    removed_files: removedFiles,
    failed_files: failedFiles,
  };
}

/** A video publication has no post row and no site page: its whole state hangs
 * off the draft by foreign key. What does not hang off it is the journal, which
 * is keyed by ref, and the source upload, which is shared with whatever else
 * points at the same asset. */
async function purgeVideoPublication(backendDb: BackendDb, videoDraftId: number, apply: boolean, fetchImpl: typeof fetch) {
  const sqlite = unsafeDb(backendDb).sqlite;
  const ref = `video:${videoDraftId}`;
  const draft = sqlite.query("SELECT studio_media_asset_id AS assetId FROM video_drafts WHERE id=?").get(videoDraftId) as {
    assetId: number;
  } | null;
  if (!draft) throw new Error(`publication not found: ${ref}`);
  const statements = videoPurgeStatements(videoDraftId, ref);
  const rows = Object.fromEntries(
    statements
      .map((statement) => [statement.name, count(sqlite.query(statement.countSql).get(...statement.args))] as const)
      .filter(([, value]) => value > 0),
  );
  const files = orphanedAssetFiles(backendDb, draft.assetId, videoDraftId);
  if (!apply) return { ok: true, applied: false, action: "purge", ref, video_draft_id: videoDraftId, rows, files };

  const verified = await assertTargetsAbsent(videoTargetStates(sqlite, videoDraftId), fetchImpl);
  const deleted = sqlite
    .transaction(() => {
      // Same fence as the text path, for the same reason: the HTTP proof cannot
      // travel in a WHERE clause, so the delete only proceeds while the targets
      // still read exactly as they did when they were checked.
      if (targetSignature(videoTargetStates(sqlite, videoDraftId)) !== targetSignature(verified))
        throw new Error(`targets for ${ref} changed while it was being verified; nothing was deleted`);
      const result: Record<string, number> = {};
      for (const statement of statements) {
        const changes = sqlite.query(statement.deleteSql).run(...statement.args).changes;
        if (changes > 0) result[statement.name] = changes;
      }
      const remaining = sqlite.query("SELECT COUNT(*) AS count FROM video_drafts WHERE id=?").get(videoDraftId);
      if (count(remaining) !== 0) throw new Error(`purge did not remove ${ref}`);
      // The asset row goes only when this draft was the last thing holding it;
      // a shared upload outlives the purge.
      if (files.length) sqlite.query("DELETE FROM studio_media_assets WHERE id=?").run(draft.assetId);
      return result;
    })
    .immediate();
  const removedFiles: string[] = [];
  const failedFiles: string[] = [];
  for (const path of files) {
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
      removedFiles.push(path);
    } catch {
      failedFiles.push(path);
    }
  }
  return {
    ok: failedFiles.length === 0,
    applied: true,
    action: "purge",
    ref,
    video_draft_id: videoDraftId,
    deleted,
    removed_files: removedFiles,
    failed_files: failedFiles,
  };
}

/** Deleting the draft cascades to all of these, but they are spelled out so the
 * plan can report what it is about to remove, one line per table. */
function videoPurgeStatements(videoDraftId: number, ref: string): PurgeStatement[] {
  const ofDraft = "video_target_id IN (SELECT id FROM video_targets WHERE video_draft_id=?)";
  const direct = (name: string, table: string, where: string, args: SqlArgs): PurgeStatement => ({
    name,
    countSql: `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
    deleteSql: `DELETE FROM ${table} WHERE ${where}`,
    args,
  });
  return [
    direct("notification_jobs", "studio_notification_jobs", "ref=?", [ref]),
    direct("post_events", "post_events", "post_key=?", [ref]),
    direct("social_comments", "social_comments", ofDraft, [videoDraftId]),
    direct("video_metric_snapshots", "video_metric_snapshots", ofDraft, [videoDraftId]),
    direct("video_metric_schedule", "video_metric_schedule", ofDraft, [videoDraftId]),
    direct("video_jobs", "video_jobs", "video_draft_id=?", [videoDraftId]),
    direct("video_targets", "video_targets", "video_draft_id=?", [videoDraftId]),
    direct("video_drafts", "video_drafts", "id=?", [videoDraftId]),
  ];
}

function videoTargetStates(sqlite: ReturnType<typeof unsafeDb>["sqlite"], videoDraftId: number): TargetState[] {
  return sqlite
    .query("SELECT target,status,external_url AS url FROM video_targets WHERE video_draft_id=? ORDER BY target")
    .all(videoDraftId) as TargetState[];
}

/** The stored source file, but only when no other video draft and no post draft
 * still points at the same asset. */
function orphanedAssetFiles(backendDb: BackendDb, assetId: number, videoDraftId: number): string[] {
  const sqlite = unsafeDb(backendDb).sqlite;
  const others = count(
    sqlite.query("SELECT COUNT(*) AS count FROM video_drafts WHERE studio_media_asset_id=? AND id<>?").get(assetId, videoDraftId),
  );
  if (others > 0 || postDraftReferencesAsset(backendDb, assetId)) return [];
  const asset = sqlite.query("SELECT local_path AS path FROM studio_media_assets WHERE id=?").get(assetId) as { path: string } | null;
  return asset?.path ? [asset.path] : [];
}

function targetStates(sqlite: ReturnType<typeof unsafeDb>["sqlite"], postKey: string): TargetState[] {
  return sqlite.query("SELECT target,status,url FROM post_targets WHERE post_key=? ORDER BY target").all(postKey) as TargetState[];
}

/** Compared instead of the rows themselves: a target appearing, changing status
 * or gaining a URL all have to count as a change. */
function targetSignature(states: TargetState[]): string {
  return states.map((state) => `${state.target}|${state.status}|${state.url ?? ""}`).join("\n");
}

/** Returns exactly what it proved absent, so the delete can refuse to run
 * against anything else. */
async function assertPublicationAbsent(
  sqlite: ReturnType<typeof unsafeDb>["sqlite"],
  postKey: string,
  fetchImpl: typeof fetch,
): Promise<TargetState[]> {
  return assertTargetsAbsent(targetStates(sqlite, postKey), fetchImpl);
}

/** Text targets and video targets are proved absent the same way, over their
 * stored public address; only the table they are read from differs. */
async function assertTargetsAbsent(targets: TargetState[], fetchImpl: typeof fetch): Promise<TargetState[]> {
  for (const target of targets) {
    if (target.status !== "published") continue;
    if (!target.url) throw new Error(`cannot prove ${target.target} is absent: no public URL is stored`);
    let response: Response;
    try {
      response = await fetchImpl(target.url, {
        headers: { "user-agent": "solo-publisher-purge/1.0" },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(`cannot prove ${target.target} is absent: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status !== 404 && response.status !== 410)
      throw new Error(`${target.target} is still reachable at ${target.url} (HTTP ${response.status})`);
  }
  return targets;
}

function purgeStatements(postId: number, draftId: number, postKey: string, messageId: number, refs: string[]): PurgeStatement[] {
  const refMarks = refs.map(() => "?").join(",");
  const direct = (name: string, table: string, where: string, args: SqlArgs): PurgeStatement => ({
    name,
    countSql: `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
    deleteSql: `DELETE FROM ${table} WHERE ${where}`,
    args,
  });
  return [
    direct("notification_jobs", "studio_notification_jobs", `ref IN (${refMarks})`, refs),
    direct("post_events", "post_events", `post_key IN (${refMarks})`, refs),
    direct("draft_story_cards", "draft_story_cards", "draft_id=?", [draftId]),
    direct("draft_sources", "draft_sources", "draft_id=?", [draftId]),
    direct("draft_entity_candidates", "draft_entity_candidates", "draft_id=?", [draftId]),
    direct("conversation_sessions", "conversation_sessions", "draft_id=?", [draftId]),
    direct("pending_albums", "pending_albums", "draft_id=?", [draftId]),
    direct("post_metrics", "post_metrics", "post_key=?", [postKey]),
    direct("metric_samples", "metric_samples", "post_key=?", [postKey]),
    direct("metric_schedule", "metric_schedule", "post_key=?", [postKey]),
    {
      name: "x_activity_links",
      countSql: "SELECT COUNT(*) AS count FROM x_activity_items WHERE linked_post_key=?",
      deleteSql: "UPDATE x_activity_items SET linked_post_key=NULL WHERE linked_post_key=?",
      args: [postKey],
    },
    direct("post_sources", "post_sources", "post_id=?", [postId]),
    direct("post_entity_links", "post_entity_links", "post_id=?", [postId]),
    direct("post_locales", "post_locales", "post_id=?", [postId]),
    direct("post_targets", "post_targets", "post_key=?", [postKey]),
    direct("site_jobs", "site_jobs", "post_id=?", [postId]),
    direct("site_source_items", "site_source_items", "message_id=? AND json_extract(item_json,'$.post_id')=?", [messageId, postId]),
    direct("publish_jobs", "publish_jobs", "post_id=? OR post_key=?", [postId, postKey]),
    direct("publication_plans", "publication_plans", "post_id=?", [postId]),
    direct("publication_sources", "publication_sources", "post_id=?", [postId]),
    direct("posts", "posts", "post_id=? OR post_key=?", [postId, postKey]),
    direct("publications", "publications", "post_id=? AND draft_id=?", [postId, draftId]),
    direct("drafts", "drafts", "id=? AND post_id=?", [draftId, postId]),
  ];
}

function count(row: unknown): number {
  return Number((row as { count?: number } | null)?.count ?? 0);
}
