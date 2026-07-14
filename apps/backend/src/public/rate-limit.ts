type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** In-memory abuse guard for anonymous public endpoints. */
export function allowPublicRequest(
  key: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): { allowed: boolean; retryAfter: number } {
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, retryAfter: windowSeconds };
  }
  const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  if (current.count >= limit) return { allowed: false, retryAfter };
  current.count += 1;
  return { allowed: true, retryAfter };
}
