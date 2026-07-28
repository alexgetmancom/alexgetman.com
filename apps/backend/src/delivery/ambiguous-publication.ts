export class AmbiguousPublicationError extends Error {
  readonly cause: unknown;

  constructor(
    readonly provider: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`verification_required: ${provider} may have published before confirmation was lost: ${detail}`);
    this.cause = cause;
  }
}

/** Only transport loss after a public create/publish mutation is ambiguous.
 * Provider HTTP responses are authoritative failures unless a provider adapter
 * explicitly recognizes them as an idempotent success. */
export function isAmbiguousTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("status" in error && typeof error.status === "number") return false;
  const text = error.message.toLowerCase();
  return [
    "timed out",
    "timeout",
    "network",
    "connection reset",
    "connection closed",
    "socket",
    "fetch failed",
    "unable to connect",
    "econnreset",
    "etimedout",
  ].some((marker) => text.includes(marker));
}

export async function ambiguousExternalMutation<T>(provider: string, mutation: () => Promise<T>): Promise<T> {
  try {
    return await mutation();
  } catch (error) {
    if (isAmbiguousTransportFailure(error)) throw new AmbiguousPublicationError(provider, error);
    throw error;
  }
}

export function isAmbiguousPublicationError(error: unknown): error is AmbiguousPublicationError {
  return error instanceof AmbiguousPublicationError;
}
