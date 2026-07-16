/** A collector error that must freeze its checkpoint instead of retrying. */
export class TerminalMetricError extends Error {
  readonly terminal = true;
}

export function isTerminalMetricError(error: unknown): error is TerminalMetricError {
  return error instanceof TerminalMetricError;
}

export function terminalIfMissingRemoteObject(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b(?:400|401|403|404)\b|unsupported(?:\s+field|\s+metric|\s+get request)?|metrics_not_implemented|insufficient(?:\s+authentication)?\s+scopes?|does not exist|missing permissions|access_denied|error_subcode\D*33)/i.test(
    message,
  )
    ? new TerminalMetricError(message)
    : error instanceof Error
      ? error
      : new Error(message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
