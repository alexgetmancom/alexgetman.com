import crypto from "node:crypto";
import type { Bot } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { recordWorkerState } from "./workerState.js";

const REQUIREMENTS: Record<string, string[]> = {
  controller_bot: ["CONTROLLER_BOT_TOKEN", "ADMIN_IDS"],
  telegram: ["CONTROLLER_BOT_TOKEN"],
  threads_ru: ["THREADS_ACCESS_TOKEN"],
  threads_en: ["THREADS_EN_ACCESS_TOKEN"],
  facebook: ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"],
  facebook_ru: ["FACEBOOK_RU_PAGE_ID", "FACEBOOK_RU_PAGE_ACCESS_TOKEN"],
  linkedin: ["LINKEDIN_AUTHOR_URN", "LINKEDIN_ACCESS_TOKEN"],
  x: ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"],
  bluesky: ["BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD"],
  mastodon: ["MASTODON_INSTANCE", "MASTODON_ACCESS_TOKEN"],
  devto: ["DEVTO_API_KEY"],
  github: ["GITHUB_DISCUSSIONS_TOKEN"],
  telegram_stories: ["TELEGRAM_CHANNEL_STORIES_API_ID", "TELEGRAM_CHANNEL_STORIES_API_HASH", "TELEGRAM_CHANNEL_STORIES_SESSION"],
  instagram_stories: ["INSTAGRAM_EN_USER_ID", "INSTAGRAM_EN_ACCESS_TOKEN"],
  instagram_stories_ru: ["INSTAGRAM_RU_USER_ID", "INSTAGRAM_RU_ACCESS_TOKEN"],
};

export async function runObservabilityCycle(config: BackendConfig, backendDb: BackendDb, bot: Bot | null): Promise<{ alerts: number; credentials: number }> {
  const credentials = updateCredentialChecks(config, backendDb);
  scanPublicationFailures(config, backendDb);
  let alerts = 0;
  const events = backendDb.sqlite.prepare(
    "SELECT id,event_type,severity,target,message,created_at FROM post_events WHERE severity IN ('warn','error') AND acked_at IS NULL ORDER BY created_at,id LIMIT 20",
  ).all() as Array<{ id: number; event_type: string; severity: string; target: string | null; message: string; created_at: string }>;
  for (const event of events) {
    const key = crypto.createHash("sha256").update(`${event.event_type}\0${event.target ?? ""}\0${event.message}`).digest("hex");
    const dedup = backendDb.sqlite.prepare("SELECT last_sent_at,suppressed_count FROM alert_dedup WHERE alert_key=?").get(key) as { last_sent_at?: string; suppressed_count?: number } | undefined;
    const cooling = dedup?.last_sent_at && Date.now() - new Date(dedup.last_sent_at).getTime() < config.ALERT_COOLDOWN_SECONDS * 1000;
    if (cooling) {
      backendDb.sqlite.prepare("UPDATE alert_dedup SET suppressed_count=suppressed_count+1 WHERE alert_key=?").run(key);
      backendDb.sqlite.prepare("UPDATE post_events SET acked_at=? WHERE id=?").run(new Date().toISOString(), event.id);
      continue;
    }
    if (bot && config.ADMIN_IDS[0]) {
      await bot.api.sendMessage(config.ADMIN_IDS[0], `[${event.severity.toUpperCase()}] ${event.target ?? event.event_type}\n${event.message}`.slice(0, 4000));
      alerts += 1;
      const now = new Date().toISOString();
      backendDb.sqlite.prepare(`INSERT INTO alert_dedup(alert_key,last_sent_at,suppressed_count) VALUES (?,?,0)
        ON CONFLICT(alert_key) DO UPDATE SET last_sent_at=excluded.last_sent_at,suppressed_count=0`).run(key, now);
      backendDb.sqlite.prepare("UPDATE post_events SET acked_at=? WHERE id=?").run(now, event.id);
    }
  }
  recordWorkerState(backendDb, "observability", { alerts, credentials });
  return { alerts, credentials };
}

function scanPublicationFailures(config: BackendConfig, backendDb: BackendDb): void {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - config.PUBLISH_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const stale = backendDb.sqlite.prepare("SELECT job_id,post_key,target,locked_at FROM publish_jobs WHERE status='publishing' AND locked_at<?").all(staleBefore) as Array<{ job_id: number; post_key: string | null; target: string; locked_at: string }>;
  const failed = backendDb.sqlite.prepare("SELECT post_key,target,last_error FROM publish_jobs WHERE status='failed' ORDER BY updated_at DESC LIMIT 100").all() as Array<{ post_key: string | null; target: string; last_error: string | null }>;
  const insert = backendDb.sqlite.prepare("INSERT INTO post_events(post_key,event_type,severity,target,message,details_json,created_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM post_events WHERE post_key IS ? AND event_type=? AND target IS ? AND acked_at IS NULL)");
  backendDb.sqlite.transaction(() => {
    for (const job of stale) insert.run(job.post_key, "queue.stale", "error", job.target, `Publish job ${job.job_id} exceeded lock timeout`, JSON.stringify({ job_id: job.job_id, locked_at: job.locked_at }), now, job.post_key, "queue.stale", job.target);
    for (const job of failed) insert.run(job.post_key, "target.failed", "error", job.target, job.last_error ?? `${job.target} failed`, "{}", now, job.post_key, "target.failed", job.target);
  })();
}

function updateCredentialChecks(config: BackendConfig, backendDb: BackendDb): number {
  const values = config as unknown as Record<string, unknown>;
  const now = new Date().toISOString();
  const statement = backendDb.sqlite.prepare(`INSERT INTO credential_checks(target,status,required_env_json,missing_env_json,last_checked_at,next_check_at,last_error,details_json)
    VALUES (?,?,?,?,?,?,NULL,'{}') ON CONFLICT(target) DO UPDATE SET status=excluded.status,required_env_json=excluded.required_env_json,missing_env_json=excluded.missing_env_json,last_checked_at=excluded.last_checked_at,next_check_at=excluded.next_check_at,last_error=NULL`);
  backendDb.sqlite.transaction(() => {
    for (const [target, required] of Object.entries(REQUIREMENTS)) {
      const missing = required.filter((name) => name === "ADMIN_IDS" ? config.ADMIN_IDS.length === 0 : !values[name]);
      statement.run(target, missing.length ? "missing" : "ready", JSON.stringify(required), JSON.stringify(missing), now, new Date(Date.now() + 3_600_000).toISOString());
    }
  })();
  return Object.keys(REQUIREMENTS).length;
}
