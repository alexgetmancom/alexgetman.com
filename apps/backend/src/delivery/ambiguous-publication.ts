import { ExternalTransportError } from "../foundation/http.js";
import { OperationTimeoutError } from "../foundation/runtime/timeout.js";

export class AmbiguousPublicationError extends Error {
  constructor(
    readonly provider: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`verification_required: ${provider} may have published before confirmation was lost: ${detail}`, { cause });
  }
}

/** Only transport loss after a public create/publish mutation is ambiguous.
 * Provider HTTP responses are authoritative failures unless a provider adapter
 * explicitly recognizes them as an idempotent success. */
export function isAmbiguousTransportFailure(error: unknown): boolean {
  return error instanceof ExternalTransportError || error instanceof OperationTimeoutError;
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
