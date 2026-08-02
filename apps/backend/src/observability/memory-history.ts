import { lt } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { runtimeMemorySamples } from "../db/schema.js";
import { gitRevision } from "../foundation/runtime/git.js";
import type { MemorySnapshot } from "./memory.js";

const retentionDays = 30;
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
const revision = gitRevision();

/** Stores one small sample in the durable /data database and bounds its age. */
export function recordMemorySample(backendDb: BackendDb, snapshot: MemorySnapshot, now = new Date()): void {
  const observedAt = now.toISOString();
  backendDb.db
    .insert(runtimeMemorySamples)
    .values({
      observedAt,
      processStartedAt,
      revision,
      rssBytes: snapshot.rssBytes,
      heapUsedBytes: snapshot.heapUsedBytes,
      heapTotalBytes: snapshot.heapTotalBytes,
      externalBytes: snapshot.externalBytes,
      cgroupCurrentBytes: snapshot.cgroupCurrentBytes,
      cgroupPeakBytes: snapshot.cgroupPeakBytes,
      cgroupLimitBytes: snapshot.cgroupLimitBytes,
      cgroupAnonBytes: snapshot.cgroupAnonBytes,
      cgroupFileBytes: snapshot.cgroupFileBytes,
    })
    .run();
  backendDb.db
    .delete(runtimeMemorySamples)
    .where(lt(runtimeMemorySamples.observedAt, new Date(now.getTime() - retentionDays * millisecondsPerDay).toISOString()))
    .run();
}
