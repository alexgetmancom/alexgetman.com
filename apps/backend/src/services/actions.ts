import type { BackendDb } from "../db/client.js";
import { enqueuePublishJob } from "../queue/publish.js";
import { localizeTargetPayload } from "../publicationPayload.js";

export type CommandAction = {
  action: string;
  ref?: string;
  message_id?: number;
  target?: string;
  text_en?: string;
  media_en_json?: string;
  token?: string;
};

export function runCommandAction(backendDb: BackendDb, input: CommandAction): Record<string, unknown> {
  const ref = input.ref || (input.message_id == null ? "" : String(input.message_id));
  if (!ref) throw new Error("missing publication ref");
  const postId = resolvePostId(backendDb, ref);
  if (!postId) throw new Error(`publication not found: ${ref}`);
  let result: Record<string, unknown>;
  if (input.action === "retry" || input.action === "republish") result = requeue(backendDb, postId, input.target);
  else if (input.action === "edit_en") result = editEnglish(backendDb, postId, input.text_en ?? "");
  else if (input.action === "replace_en_media") result = replaceEnglishMedia(backendDb, postId, parseMedia(input.media_en_json));
  else if (input.action === "use_ru_media_for_en") result = replaceEnglishMedia(backendDb, postId, null);
  else throw new Error(`unknown action: ${input.action}`);
  recordAction(backendDb, input.action, postId, input.target ?? null, result);
  return result;
}

function requeue(backendDb: BackendDb, postId: number, target?: string): Record<string, unknown> {
  const sourceRow = backendDb.sqlite.prepare("SELECT item_json FROM publication_sources WHERE post_id=?").get(postId) as { item_json?: string } | undefined;
  const source = parseObject(sourceRow?.item_json);
  const rows = backendDb.sqlite.prepare(
    `SELECT * FROM publish_jobs WHERE post_id=? ${target ? "AND target=?" : ""} ORDER BY job_id DESC`,
  ).all(...(target ? [postId, target] : [postId])) as Array<Record<string, unknown>>;
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of rows) if (!latest.has(String(row.target))) latest.set(String(row.target), row);
  if (latest.size === 0) throw new Error("no publish jobs found");
  const queued: string[] = [];
  backendDb.sqlite.transaction(() => {
    for (const [targetId, row] of latest) {
      const existing = backendDb.sqlite.prepare("SELECT job_id FROM publish_jobs WHERE post_id=? AND target=? AND status='queued'").get(postId, targetId);
      if (!existing) {
        enqueuePublishJob(backendDb, {
          postId,
          postKey: String(row.post_key ?? `post:${postId}`),
          messageId: Number(row.message_id),
          target: targetId,
          payload: localizeTargetPayload(Object.keys(source).length > 0 ? source : parseObject(row.payload_json), targetId),
        });
      }
      backendDb.sqlite.prepare(`INSERT INTO post_targets(post_key,target,status,error,skipped,updated_at,raw_json)
        VALUES (?,?,'queued',NULL,0,?,?) ON CONFLICT(post_key,target) DO UPDATE SET status='queued',error=NULL,skipped=0,updated_at=excluded.updated_at,raw_json=excluded.raw_json`)
        .run(String(row.post_key ?? `post:${postId}`), targetId, new Date().toISOString(), JSON.stringify({ requeued: true }));
      queued.push(targetId);
    }
    backendDb.sqlite.prepare("UPDATE publications SET status='published', updated_at=? WHERE post_id=?").run(new Date().toISOString(), postId);
  })();
  return { ok: true, post_id: postId, target: target ?? null, targets: queued };
}

function editEnglish(backendDb: BackendDb, postId: number, text: string): Record<string, unknown> {
  const value = text.trim();
  if (!value) throw new Error("text_en is required");
  const now = new Date().toISOString();
  backendDb.sqlite.transaction(() => {
    backendDb.sqlite.prepare("UPDATE drafts SET text_en_approved=?, updated_at=? WHERE post_id=?").run(value, now, postId);
    backendDb.sqlite.prepare("UPDATE post_locales SET text=?, updated_at=? WHERE post_id=? AND locale='en'").run(value, now, postId);
    backendDb.sqlite.prepare("UPDATE posts SET text_en=?, updated_at=? WHERE post_key=?").run(value, now, `post:${postId}`);
    updateSource(backendDb, postId, { text_en: value, bodyMarkdown: value });
    enqueueRepairSiteJob(backendDb, postId, "edit_en", now);
  })();
  return { ok: true, post_id: postId, text_en: true };
}

function replaceEnglishMedia(backendDb: BackendDb, postId: number, media: Record<string, unknown>[] | null): Record<string, unknown> {
  const now = new Date().toISOString();
  backendDb.sqlite.transaction(() => {
    backendDb.sqlite.prepare("UPDATE drafts SET media_en_json=?, updated_at=? WHERE post_id=?").run(media == null ? null : JSON.stringify(media), now, postId);
    const ru = backendDb.sqlite.prepare("SELECT media_json FROM post_locales WHERE post_id=? AND locale='ru'").get(postId) as { media_json?: string } | undefined;
    const effective = media == null ? parseArray(ru?.media_json) : media;
    backendDb.sqlite.prepare("UPDATE post_locales SET media_json=?, updated_at=? WHERE post_id=? AND locale='en'").run(JSON.stringify(effective), now, postId);
    updateSource(backendDb, postId, { media_en: media });
    enqueueRepairSiteJob(backendDb, postId, media == null ? "use_ru_media_for_en" : "replace_en_media", now);
  })();
  return { ok: true, post_id: postId, media_en: media != null };
}

function updateSource(backendDb: BackendDb, postId: number, patch: Record<string, unknown>): void {
  const row = backendDb.sqlite.prepare("SELECT item_json FROM publication_sources WHERE post_id=?").get(postId) as { item_json?: string } | undefined;
  const source = { ...parseObject(row?.item_json), ...patch };
  backendDb.sqlite.prepare("UPDATE publication_sources SET item_json=?, updated_at=? WHERE post_id=?").run(JSON.stringify(source), new Date().toISOString(), postId);
  const message = backendDb.sqlite.prepare("SELECT telegram_message_id FROM publications WHERE post_id=?").get(postId) as { telegram_message_id?: number | null } | undefined;
  if (message?.telegram_message_id) backendDb.sqlite.prepare("UPDATE site_source_items SET item_json=?, updated_at=? WHERE message_id=?").run(JSON.stringify(source), new Date().toISOString(), message.telegram_message_id);
}

function enqueueRepairSiteJob(backendDb: BackendDb, postId: number, reason: string, now: string): void {
  const row = backendDb.sqlite.prepare("SELECT COALESCE(telegram_message_id, post_id) AS message_id FROM publications WHERE post_id=?").get(postId) as { message_id: number };
  backendDb.sqlite.prepare("INSERT INTO site_jobs(post_id,message_id,reason,status,next_attempt_at,created_at,updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)").run(postId, row.message_id, reason, now, now, now);
}

function resolvePostId(backendDb: BackendDb, ref: string): number | null {
  const direct = ref.match(/^post:(\d+)$/)?.[1] ?? (/^\d+$/.test(ref) ? ref : null);
  if (direct) {
    const id = Number(direct);
    const publication = backendDb.sqlite.prepare("SELECT post_id FROM publications WHERE post_id=? OR telegram_message_id=?").get(id, id) as { post_id?: number } | undefined;
    if (publication?.post_id) return publication.post_id;
    const post = backendDb.sqlite.prepare("SELECT post_id FROM posts WHERE message_id=? OR post_key=?").get(id, `post:${id}`) as { post_id?: number } | undefined;
    if (post?.post_id) return post.post_id;
  }
  return null;
}

function parseMedia(raw: string | undefined): Record<string, unknown>[] | null {
  if (!raw || ["none", "null", "ru", "fallback"].includes(raw.trim().toLowerCase())) return null;
  const parsed = JSON.parse(raw) as unknown;
  const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
  if (!items || items.some((item) => !item || typeof item !== "object" || !(item as Record<string, unknown>).file_id)) throw new Error("each media item needs file_id");
  return items as Record<string, unknown>[];
}

function recordAction(backendDb: BackendDb, action: string, postId: number, target: string | null, details: Record<string, unknown>): void {
  const message = backendDb.sqlite.prepare("SELECT telegram_message_id FROM publications WHERE post_id=?").get(postId) as { telegram_message_id?: number | null } | undefined;
  const now = new Date().toISOString();
  backendDb.sqlite.prepare("INSERT INTO ops_actions(actor_type,action,message_id,target,status,details_json,created_at,completed_at) VALUES ('command-center',?,?,?,?,?,?,?)")
    .run(action, message?.telegram_message_id ?? null, target, "ok", JSON.stringify(details), now, now);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

function parseArray(value: unknown): Record<string, unknown>[] {
  if (typeof value !== "string" || !value) return [];
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : []; } catch { return []; }
}
