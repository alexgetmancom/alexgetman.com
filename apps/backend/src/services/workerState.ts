import type { BackendDb } from "../db/client.js";

export function recordWorkerState(backendDb: BackendDb, name: string, state: Record<string, unknown>, error: string | null = null): void {
  const now = new Date().toISOString();
  const payload = { ...state, ok: error == null, last_run_at: now, last_error: error };
  backendDb.sqlite
    .prepare(
      `INSERT INTO worker_state(name, state_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`,
    )
    .run(name, JSON.stringify(payload), now);
}
