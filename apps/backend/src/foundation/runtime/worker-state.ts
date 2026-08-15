import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { type JsonValue, workerState } from "../../db/schema.js";

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
  unsafeDb(backendDb)
    .db.insert(workerState)
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
    unsafeDb(backendDb).db.select({ stateJson: workerState.stateJson }).from(workerState).where(eq(workerState.name, name)).get()
      ?.stateJson ?? {};
  const payload = { ...current, ...state, scheduler_error: schedulerError, last_heartbeat_at: now };
  unsafeDb(backendDb)
    .db.insert(workerState)
    .values({ name, stateJson: payload, updatedAt: now })
    .onConflictDoUpdate({ target: workerState.name, set: { stateJson: payload, updatedAt: now } })
    .run();
}

/** Names expected once the corresponding runtime has started its workers. The
 * site loops are on this list whether or not the Studio serves a site: they are
 * started either way and idle on the flag inside the tick, so leaving them off
 * hid two running, healthy workers from `status` and from the health report. */
export function expectedWorkerNames(): string[] {
  return [
    "story-cards",
    "queue",
    "publish-watchdog",
    "publication-reconciliation",
    "notifications",
    "video",
    "metrics",
    "creator-analytics",
    "metric-retention",
    "site",
    "site-watchdog",
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
