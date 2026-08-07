// This is intentionally process-local. It only closes the double-tap window
// inside one bot process; durable service idempotency and database constraints
// remain responsible for correctness across restarts or multiple replicas.
const inFlight = new Map<string, number>();

/** A held lock expires on its own. Without this, an action that never settles
 * (a hung Telegram or deploy request) would leave its key held forever and the
 * button would silently do nothing until the process restarts. The window is
 * far longer than the slowest real action (a deploy, ~150s). */
const ACTION_LOCK_TTL_MS = 5 * 60_000;

/** Guards a mutating action (publish, cancel, deploy) against a double tap
 * arriving before the first tap's confirmation has rendered. Runs `action`
 * only if `key` isn't already in flight; returns `{ ok: false }` for the
 * duplicate tap instead of running it a second time. */
export async function withActionLock<T>(key: string, action: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const heldSince = inFlight.get(key);
  if (heldSince !== undefined && Date.now() - heldSince < ACTION_LOCK_TTL_MS) return { ok: false };
  inFlight.set(key, Date.now());
  try {
    return { ok: true, value: await action() };
  } finally {
    inFlight.delete(key);
  }
}
