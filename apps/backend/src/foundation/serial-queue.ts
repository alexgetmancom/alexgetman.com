/** One promise chain that runs enqueued work strictly one-at-a-time, regardless of
 * whether earlier work resolved or rejected. Each `createSerialQueue()` call owns
 * an independent lane; unrelated work should use separate queues.
 * Mirrored at deploy/media-processor/serial-queue.ts for that isolated Docker
 * build context; keep both in sync if the queueing behavior ever changes. */
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
