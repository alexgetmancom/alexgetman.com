import { describe, expect, it } from "bun:test";
import { isTransientDeploymentError, withRetry } from "./retry.ts";

describe("deployment retry", () => {
  it("retries transient failures with exponential backoff", async () => {
    let calls = 0;
    const delays: number[] = [];

    await expect(
      withRetry(
        async () => {
          calls += 1;
          if (calls < 3) throw new Error("failed to do request: dial tcp: i/o timeout");
          return "ok";
        },
        {
          attempts: 3,
          initialDelayMs: 100,
          maxDelayMs: 500,
          shouldRetry: isTransientDeploymentError,
          sleep: async (milliseconds) => {
            delays.push(milliseconds);
          },
        },
      ),
    ).resolves.toBe("ok");

    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry permanent registry errors", async () => {
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("manifest unknown: 404");
        },
        {
          attempts: 3,
          initialDelayMs: 0,
          maxDelayMs: 0,
          shouldRetry: isTransientDeploymentError,
        },
      ),
    ).rejects.toThrow("manifest unknown: 404");

    expect(calls).toBe(1);
  });
});
