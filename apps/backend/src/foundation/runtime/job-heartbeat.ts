/** Runs work while periodically refreshing a durable job lease. */
export async function withJobHeartbeat<T>(intervalSeconds: number, heartbeat: () => void, work: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    try {
      heartbeat();
    } catch {
      // A missed beat is harmless on its own; the next one lands inside the lease timeout.
    }
  }, intervalSeconds * 1000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
