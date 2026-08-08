import { readFileSync } from "node:fs";
import { log } from "../foundation/logger.js";

const bytesPerMegabyte = 1024 * 1024;

export type MemorySnapshot = {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  cgroupCurrentBytes: number | null;
  cgroupPeakBytes: number | null;
  cgroupLimitBytes: number | null;
  cgroupAnonBytes: number | null;
  cgroupFileBytes: number | null;
};

type MemoryMeasurementOptions = {
  readSnapshot?: () => MemorySnapshot;
  writeLog?: typeof log;
  now?: () => number;
};

type MemoryContext = Record<string, string | number | boolean | null | undefined>;

const cgroupCurrentPaths = ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"];
const cgroupPeakPaths = ["/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"];
const cgroupLimitPaths = ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"];

function readCgroupBytes(paths: readonly string[]): number | null {
  for (const path of paths) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (!raw || raw === "max") return null;
      const bytes = Number(raw);
      if (Number.isSafeInteger(bytes) && bytes > 0) return bytes;
    } catch {
      // Bare-metal and test processes may not expose cgroup memory files.
    }
  }
  return null;
}

function readCgroupStatBytes(): { anonBytes: number | null; fileBytes: number | null } {
  for (const path of ["/sys/fs/cgroup/memory.stat", "/sys/fs/cgroup/memory/memory.stat"]) {
    try {
      const values = new Map(
        readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/, 2) as [string, string]),
      );
      const bytes = (keys: readonly string[]) => {
        for (const key of keys) {
          const value = Number(values.get(key));
          if (Number.isSafeInteger(value) && value >= 0) return value;
        }
        return null;
      };
      return { anonBytes: bytes(["anon", "total_rss", "rss"]), fileBytes: bytes(["file", "total_cache", "cache"]) };
    } catch {
      // Bare-metal and test processes may not expose cgroup memory statistics.
    }
  }
  return { anonBytes: null, fileBytes: null };
}

export function readMemorySnapshot(): MemorySnapshot {
  const memory = process.memoryUsage();
  const cgroupStat = readCgroupStatBytes();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    cgroupCurrentBytes: readCgroupBytes(cgroupCurrentPaths),
    cgroupPeakBytes: readCgroupBytes(cgroupPeakPaths),
    cgroupLimitBytes: readCgroupBytes(cgroupLimitPaths),
    cgroupAnonBytes: cgroupStat.anonBytes,
    cgroupFileBytes: cgroupStat.fileBytes,
  };
}

function megabytes(bytes: number | null): number | null {
  return bytes === null ? null : Math.round((bytes / bytesPerMegabyte) * 10) / 10;
}

function deltaMegabytes(after: number | null, before: number | null): number | null {
  return after === null || before === null ? null : megabytes(after - before);
}

/** Logs before/after memory at an expensive synchronous boundary. */
export function measureMemorySync<T>(operation: string, context: MemoryContext, run: () => T, options: MemoryMeasurementOptions = {}): T {
  const readSnapshot = options.readSnapshot ?? readMemorySnapshot;
  const writeLog = options.writeLog ?? log;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const before = readSnapshot();
  let success = false;
  let failure: unknown;

  try {
    const result = run();
    success = true;
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const after = readSnapshot();
    writeLog(success ? "info" : "warn", "memory measurement", {
      operation,
      ...context,
      success,
      durationMs: Math.max(0, now() - startedAt),
      rssBeforeMb: megabytes(before.rssBytes),
      rssAfterMb: megabytes(after.rssBytes),
      rssDeltaMb: deltaMegabytes(after.rssBytes, before.rssBytes),
      heapUsedBeforeMb: megabytes(before.heapUsedBytes),
      heapUsedAfterMb: megabytes(after.heapUsedBytes),
      heapUsedDeltaMb: deltaMegabytes(after.heapUsedBytes, before.heapUsedBytes),
      externalBeforeMb: megabytes(before.externalBytes),
      externalAfterMb: megabytes(after.externalBytes),
      externalDeltaMb: deltaMegabytes(after.externalBytes, before.externalBytes),
      cgroupCurrentBeforeMb: megabytes(before.cgroupCurrentBytes),
      cgroupCurrentAfterMb: megabytes(after.cgroupCurrentBytes),
      cgroupCurrentDeltaMb: deltaMegabytes(after.cgroupCurrentBytes, before.cgroupCurrentBytes),
      cgroupPeakAfterMb: megabytes(after.cgroupPeakBytes),
      cgroupPeakDeltaMb: deltaMegabytes(after.cgroupPeakBytes, before.cgroupPeakBytes),
      ...(failure === undefined ? {} : { error: String(failure) }),
    });
  }
}
