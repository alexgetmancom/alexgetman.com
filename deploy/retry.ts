export type RetryOptions = {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (error: unknown) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (error: unknown, failedAttempt: number, delayMs: number) => void;
};

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Retry a bounded number of times, doubling the delay between attempts. */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts));
  const initialDelayMs = Math.max(0, Math.floor(options.initialDelayMs));
  const maxDelayMs = Math.max(initialDelayMs, Math.floor(options.maxDelayMs));
  const sleep = options.sleep ?? defaultSleep;
  let delayMs = initialDelayMs;

  for (let failedAttempt = 1; ; failedAttempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (failedAttempt >= attempts || !options.shouldRetry(error)) throw error;
      options.onRetry?.(error, failedAttempt, delayMs);
      if (delayMs > 0) await sleep(delayMs);
      delayMs = Math.min(maxDelayMs, delayMs * 2);
    }
  }
}

/** Registry clients surface transient DNS, TCP, TLS and gateway failures as plain errors. */
export function isTransientDeploymentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:i\/o timeout|context deadline exceeded|tls handshake timeout|temporary failure in name resolution|no such host|network is unreachable|connection (?:reset|refused|timed out)|unexpected eof|fetch failed|\b(?:408|425|429|502|503|504)\b|\btimeout\b)/i.test(
    message,
  );
}
