import { describe, expect, it } from "bun:test";
import { type MemorySnapshot, measureMemorySync } from "../src/observability/memory.js";

const megabyte = 1024 * 1024;

function snapshot(overrides: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    rssBytes: 80 * megabyte,
    heapUsedBytes: 30 * megabyte,
    heapTotalBytes: 40 * megabyte,
    externalBytes: 5 * megabyte,
    cgroupCurrentBytes: 100 * megabyte,
    cgroupPeakBytes: 120 * megabyte,
    cgroupLimitBytes: 512 * megabyte,
    cgroupAnonBytes: 70 * megabyte,
    cgroupFileBytes: 30 * megabyte,
    ...overrides,
  };
}

describe("memory measurements", () => {
  it("records before and after memory with a route context", () => {
    const logs: Array<{ level: string; message: string; details: Record<string, unknown> }> = [];
    const samples = [
      snapshot(),
      snapshot({ rssBytes: 90 * megabyte, cgroupCurrentBytes: 125 * megabyte, cgroupPeakBytes: 150 * megabyte }),
    ];
    let clock = 1000;

    expect(
      measureMemorySync(
        "test.dashboard.render",
        { route: "/command-center", period: "1" },
        () => {
          clock = 1042;
          return "result";
        },
        {
          readSnapshot: () => samples.shift() ?? snapshot(),
          now: () => clock,
          writeLog: (level, message, details) => logs.push({ level, message, details: details as Record<string, unknown> }),
        },
      ),
    ).toBe("result");

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "info",
      message: "memory measurement",
      details: {
        operation: "test.dashboard.render",
        route: "/command-center",
        period: "1",
        success: true,
        durationMs: 42,
        rssBeforeMb: 80,
        rssAfterMb: 90,
        rssDeltaMb: 10,
        cgroupCurrentBeforeMb: 100,
        cgroupCurrentAfterMb: 125,
        cgroupCurrentDeltaMb: 25,
        cgroupPeakAfterMb: 150,
        cgroupPeakDeltaMb: 30,
      },
    });
  });

  it("logs a failed operation and rethrows the original error", () => {
    const logs: Array<{ level: string; message: string; details: Record<string, unknown> }> = [];
    const error = new Error("boom");
    const samples = [snapshot(), snapshot({ rssBytes: 81 * megabyte })];

    expect(() =>
      measureMemorySync(
        "test.dashboard.render",
        { route: "/command-center" },
        () => {
          throw error;
        },
        {
          readSnapshot: () => samples.shift() ?? snapshot(),
          writeLog: (level, message, details) => logs.push({ level, message, details: details as Record<string, unknown> }),
        },
      ),
    ).toThrow(error);

    expect(logs[0]).toMatchObject({ level: "warn", details: { success: false, error: "Error: boom" } });
  });
});
