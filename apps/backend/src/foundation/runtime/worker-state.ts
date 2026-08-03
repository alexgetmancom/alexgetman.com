import { eq } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { type JsonValue, workerState } from "../../db/schema.js";
import type { BackendConfig } from "../config.js";

/** Runtime heartbeat persistence shared by background cycles. */
export function recordWorkerState(backendDb: BackendDb, name: string, state: Record<string, JsonValue>, error: string | null = null): void {
  const now = new Date().toISOString();
  const payload = {
    ...state,
    ok: error == null,
    last_run_at: now,
    last_error: error,
    scheduler_error: null,
    last_heartbeat_at: now,
  };
  backendDb.db
    .insert(workerState)
    .values({ name, stateJson: payload, updatedAt: now })
    .onConflictDoUpdate({ target: workerState.name, set: { stateJson: payload, updatedAt: now } })
    .run();
}

/** Updates lifecycle metadata without overwriting a cycle's counters or verdict. */
export function recordWorkerHeartbeat(
  backendDb: BackendDb,
  name: string,
  state: Record<string, JsonValue> = {},
  schedulerError: string | null = null,
): void {
  const now = new Date().toISOString();
  const current =
    backendDb.db.select({ stateJson: workerState.stateJson }).from(workerState).where(eq(workerState.name, name)).get()?.stateJson ?? {};
  const payload = { ...current, ...state, scheduler_error: schedulerError, last_heartbeat_at: now };
  backendDb.db
    .insert(workerState)
    .values({ name, stateJson: payload, updatedAt: now })
    .onConflictDoUpdate({ target: workerState.name, set: { stateJson: payload, updatedAt: now } })
    .run();
}

/** Names expected once the corresponding runtime has started its workers. */
export function expectedWorkerNames(config: BackendConfig): string[] {
  if (!config.ENABLE_WORKERS) return [];
  return [
    "story-cards",
    "queue",
    "publish-watchdog",
    "publication-reconciliation",
    "notifications",
    ...(config.studio.modules.video_posting ? ["video"] : []),
    ...(config.studio.modules.analytics ? ["metrics", "creator-analytics", "metric-retention"] : []),
    ...(config.studio.modules.site ? ["site", "site-watchdog"] : []),
    "media-cache",
    "operational-retention",
    "observability",
  ];
}

export function workerLiveness(
  state: Record<string, unknown>,
  updatedAt: string,
): { ageSeconds: number; stale: boolean; lastHeartbeatAt: string } {
  const lastHeartbeatAt = typeof state.last_heartbeat_at === "string" ? state.last_heartbeat_at : updatedAt;
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(lastHeartbeatAt)) / 1000));
  const intervalMs = typeof state.heartbeat_interval_ms === "number" ? state.heartbeat_interval_ms : null;
  const staleAfterSeconds = intervalMs == null ? null : Math.max(120, Math.ceil((intervalMs / 1000) * 3));
  return { ageSeconds, stale: staleAfterSeconds != null && ageSeconds > staleAfterSeconds, lastHeartbeatAt };
}
