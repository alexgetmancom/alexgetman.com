export class TerminalMetricError extends Error {
  readonly terminal = true;
}

export function isTerminalMetricError(error: unknown): error is TerminalMetricError {
  return error instanceof TerminalMetricError;
}

export function terminalIfMissingRemoteObject(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b404\b|unsupported get request|does not exist|missing permissions|error_subcode\D*33)/i.test(message)
    ? new TerminalMetricError(message)
    : error instanceof Error
      ? error
      : new Error(message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
