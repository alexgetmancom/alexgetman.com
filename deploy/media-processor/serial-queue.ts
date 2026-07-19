/** One promise chain that runs enqueued work strictly one-at-a-time, regardless of
 * whether earlier work resolved or rejected. Mirrors
 * apps/backend/src/foundation/serial-queue.ts: this Docker image's build context
 * is this directory alone, so the two cannot share a single module. Keep both in
 * sync if the queueing behavior ever needs to change. */
export function createSerialQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
