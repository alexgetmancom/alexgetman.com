import { openBackendDb as openSafeBackendDb, type UnsafeBackendDb, unsafeDb } from "../../src/db/client.js";

/** Open a raw database handle for infrastructure tests that exercise SQL directly. */
export function openBackendDb(path: string, timeout = 30_000): UnsafeBackendDb {
  const backendDb = openSafeBackendDb(path, timeout);
  return unsafeDb(backendDb) as UnsafeBackendDb;
}
