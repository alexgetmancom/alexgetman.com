type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** In-memory abuse guard for anonymous public endpoints. */
export function allowPublicRequest(
  key: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): { allowed: boolean; retryAfter: number } {
  // Sweep on every call, not only when the caller's own bucket happens to have
  // expired: a steady stream of requests over a few hot keys never reached that
  // branch, so buckets for one-off visitors accumulated for the process's life.
  for (const [otherKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(otherKey);

  const current = buckets.get(key);
  if (!current) {
    buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, retryAfter: windowSeconds };
  }
  const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  if (current.count >= limit) return { allowed: false, retryAfter };
  current.count += 1;
  return { allowed: true, retryAfter };
}
