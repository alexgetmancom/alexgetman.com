import type { BackendDb } from "../../db/client.js";
import { type JsonValue, workerState } from "../../db/schema.js";

/** Runtime heartbeat persistence shared by background cycles. */
export function recordWorkerState(backendDb: BackendDb, name: string, state: Record<string, JsonValue>, error: string | null = null): void {
  const now = new Date().toISOString();
  const payload = { ...state, ok: error == null, last_run_at: now, last_error: error };
  backendDb.db
    .insert(workerState)
    .values({ name, stateJson: payload, updatedAt: now })
    .onConflictDoUpdate({ target: workerState.name, set: { stateJson: payload, updatedAt: now } })
    .run();
}
