import { afterEach } from "bun:test";
import { type BackendDb, openBackendDb } from "../../src/db/client.js";

/** Open an in-memory backend DB for one test and always close it, even on
 * throw. Use for a single self-contained test body:
 *
 *   it("...", () => withDb((backendDb) => { ... }));
 *   it("...", async () => withDb(async (backendDb) => { ... }));
 */
export function withDb<T>(fn: (backendDb: BackendDb) => T | Promise<T>): Promise<T> {
  const backendDb = openBackendDb(":memory:");
  return (async () => fn(backendDb))().finally(() => backendDb.close());
}

/** Call once per describe block to get a fresh in-memory DB per test, closed
 * automatically after each one via afterEach. Use when a test needs to open
 * the DB itself (e.g. before other setup) rather than inside a callback:
 *
 *   const testDb = useBackendDb();
 *   it("...", () => {
 *     const backendDb = testDb.open();
 *     ...
 *   });
 */
export function useBackendDb(): { open: () => BackendDb } {
  let backendDb: BackendDb | null = null;
  afterEach(() => {
    backendDb?.close();
    backendDb = null;
  });
  return {
    open: () => {
      backendDb = openBackendDb(":memory:");
      return backendDb;
    },
  };
}
