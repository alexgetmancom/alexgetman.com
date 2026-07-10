import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { pipelineStatusPayload } from "./pipeline.js";

export function commandCenterPayload(config: BackendConfig, backendDb: BackendDb) {
  const queue = backendDb.sqlite
    .prepare("SELECT status, count(*) AS count FROM publish_jobs GROUP BY status ORDER BY status")
    .all() as Array<{ status: string; count: number }>;
  const targets = backendDb.sqlite
    .prepare("SELECT target, status, count(*) AS count FROM post_targets GROUP BY target, status ORDER BY target, status")
    .all() as Array<{ target: string; status: string; count: number }>;
  const events = backendDb.sqlite.prepare("SELECT * FROM post_events ORDER BY created_at DESC, id DESC LIMIT 50").all() as Record<
    string,
    unknown
  >[];
  const jobs = backendDb.sqlite.prepare("SELECT * FROM publish_jobs ORDER BY updated_at DESC, job_id DESC LIMIT 100").all() as Record<
    string,
    unknown
  >[];
  const drafts = backendDb.sqlite.prepare("SELECT * FROM drafts ORDER BY updated_at DESC, id DESC LIMIT 50").all() as Record<
    string,
    unknown
  >[];
  const credentials = optionalRows(backendDb, "SELECT * FROM credential_checks ORDER BY last_checked_at DESC LIMIT 100");
  const lifecycle = optionalRows(backendDb, "SELECT * FROM post_lifecycle ORDER BY updated_at DESC LIMIT 100");
  const actions = optionalRows(backendDb, "SELECT * FROM ops_actions ORDER BY created_at DESC, action_id DESC LIMIT 100");
  return {
    generatedAt: new Date().toISOString(),
    pipeline: pipelineStatusPayload(config, backendDb),
    queue,
    targets,
    jobs,
    drafts,
    credentials,
    lifecycle,
    actions,
    events: events.map((event) => ({
      id: event.id,
      postKey: event.post_key,
      eventType: event.event_type,
      severity: event.severity,
      target: event.target,
      message: event.message,
      details: parseJson(event.details_json),
      createdAt: event.created_at,
      ackedAt: event.acked_at,
    })),
  };
}

type ReturnTypeOfCommandCenter = ReturnType<typeof commandCenterPayload>;

export function postDebugPayload(backendDb: BackendDb, ref: string) {
  const postKey = resolvePostKey(backendDb, ref);
  if (!postKey) return null;
  const post = backendDb.sqlite.prepare("SELECT * FROM posts WHERE post_key=?").get(postKey) as Record<string, unknown> | undefined;
  const targets = backendDb.sqlite.prepare("SELECT * FROM post_targets WHERE post_key=? ORDER BY target").all(postKey) as Record<
    string,
    unknown
  >[];
  const metrics = backendDb.sqlite
    .prepare("SELECT * FROM post_metrics WHERE post_key=? ORDER BY target, metric_name")
    .all(postKey) as Record<string, unknown>[];
  const schedule = backendDb.sqlite.prepare("SELECT * FROM metric_schedule WHERE post_key=? ORDER BY target").all(postKey) as Record<
    string,
    unknown
  >[];
  const jobs = backendDb.sqlite
    .prepare("SELECT * FROM publish_jobs WHERE post_key=? OR post_id=? OR message_id=? ORDER BY job_id DESC")
    .all(postKey, numericRef(ref), numericRef(ref)) as Record<string, unknown>[];
  return {
    ref: { input: ref, postKey },
    post: post ?? null,
    targets,
    metrics,
    schedule,
    jobs,
  };
}

function resolvePostKey(backendDb: BackendDb, ref: string): string | null {
  const value = ref.trim();
  if (!value) return null;
  if (value.startsWith("post:") || value.startsWith("telegram:")) return value;
  const id = numericRef(value);
  if (id == null) return value;
  const post = backendDb.sqlite.prepare("SELECT post_key FROM posts WHERE message_id=? OR post_key=?").get(id, `post:${id}`) as
    | { post_key?: string }
    | undefined;
  if (post?.post_key) return post.post_key;
  const job = backendDb.sqlite
    .prepare(
      "SELECT COALESCE(post_key, CASE WHEN post_id IS NOT NULL THEN 'post:' || post_id ELSE NULL END) AS post_key FROM publish_jobs WHERE message_id=? OR post_id=? ORDER BY job_id DESC LIMIT 1",
    )
    .get(id, id) as { post_key?: string | null } | undefined;
  return job?.post_key ?? `telegram:alexgetmancom:${id}`;
}

function numericRef(ref: string): number | null {
  return /^\d+$/.test(ref) ? Number(ref) : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function optionalRows(backendDb: BackendDb, query: string): Record<string, unknown>[] {
  try {
    return backendDb.sqlite.prepare(query).all() as Record<string, unknown>[];
  } catch {
    return [];
  }
}
