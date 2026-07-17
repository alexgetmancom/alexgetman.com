const inFlight = new Set<string>();

/** Guards a mutating action (publish, cancel, deploy) against a double tap
 * arriving before the first tap's confirmation has rendered. Runs `action`
 * only if `key` isn't already in flight; returns `{ ok: false }` for the
 * duplicate tap instead of running it a second time. */
export async function withActionLock<T>(key: string, action: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  if (inFlight.has(key)) return { ok: false };
  inFlight.add(key);
  try {
    return { ok: true, value: await action() };
  } finally {
    inFlight.delete(key);
  }
}
