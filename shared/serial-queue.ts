/** One promise chain that runs enqueued work strictly one-at-a-time, regardless of
 * whether earlier work resolved or rejected. Each queue owns an independent lane. */
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
