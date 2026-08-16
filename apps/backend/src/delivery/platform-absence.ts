/** Only the platform saying the object is gone counts as absence. Anything
 * else — a timeout, a revoked token, a rate limit — leaves the question
 * unanswered, and an unanswered question must not erase a publication. The
 * patterns are how the platforms here spell "no such object": Graph's
 * `does not exist` and subcode 33, a plain 404, and YouTube answering a list
 * request with no items. */
export async function absentIfMissing(ask: () => Promise<unknown>): Promise<boolean> {
  try {
    await ask();
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/does not exist|error_subcode\D*33|\b404\b|did not find the expected video/i.test(message)) return true;
    throw new Error(`cannot prove the publication is absent: ${message}`);
  }
}
