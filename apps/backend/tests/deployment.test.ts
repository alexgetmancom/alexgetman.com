import { describe, expect, it, mock } from "bun:test";
import {
  deploymentPromoteCallback,
  deploymentRollbackCallback,
  parseDeploymentPromoteCallback,
  parseDeploymentRollbackAskCallback,
  parseDeploymentRollbackCallback,
  requestDeploymentPromote,
  requestDeploymentRollback,
} from "../src/foundation/deployment.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const revision = "a".repeat(40);
const agent = { DEPLOY_AGENT_URL: "http://host.docker.internal:9899", DEPLOY_AGENT_TOKEN: "t".repeat(16) };

describe("deployment callbacks", () => {
  it("refuses to build or parse a callback for anything but a Git SHA", () => {
    // A rollback target is executed verbatim by the agent. "latest" would move
    // the release pointer to whatever happens to be newest at that moment.
    expect(() => deploymentRollbackCallback("maru", "latest")).toThrow("Git SHA");
    expect(() => deploymentPromoteCallback("maru", "latest")).toThrow("Git SHA");
    expect(parseDeploymentRollbackCallback("deploy_rollback:maru:latest")).toBeNull();
    expect(parseDeploymentPromoteCallback("deploy_promote:maru:latest")).toBeNull();
    expect(parseDeploymentRollbackCallback(`deploy_rollback:maru:${revision}`)).toEqual({ target: "maru", revision });
  });

  it("keeps the confirmation tap and the executing tap on separate prefixes", () => {
    // One shared prefix would make the first tap deploy instead of asking.
    expect(parseDeploymentRollbackAskCallback(`deploy_rb_ask:maru:${revision}`)).toEqual({ target: "maru", revision });
    expect(parseDeploymentRollbackAskCallback(`deploy_rollback:maru:${revision}`)).toBeNull();
    expect(parseDeploymentRollbackCallback(`deploy_rb_ask:maru:${revision}`)).toBeNull();
  });
});

describe("deployment agent requests", () => {
  it("forwards an authenticated request to the per-action agent endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({ ok: true, release: revision, currentRevision: revision });
    });

    await requestDeploymentRollback(loadTestConfig(agent), "maru", revision, fetchImpl);
    await requestDeploymentPromote(loadTestConfig(agent), "maru", revision, fetchImpl);

    expect(calls.map((call) => call.url)).toEqual([
      "http://host.docker.internal:9899/v1/rollback/maru",
      "http://host.docker.internal:9899/v1/promote/maru",
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${"t".repeat(16)}` });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ release: revision }));
  });

  it("does not issue network requests when deployment control is disabled", async () => {
    const fetchImpl = mock(fetch);

    await expect(requestDeploymentRollback(loadTestConfig({}), "maru", revision, fetchImpl)).resolves.toEqual({
      ok: false,
      message: "Deployment agent is not configured.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries a transient agent failure before reporting deployment failure", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const fetchImpl = mock(async () => {
      attempts += 1;
      if (attempts === 1) return Response.json({ ok: false, message: "Deploy failed and was rolled back" }, { status: 502 });
      return Response.json({ ok: true, release: revision, currentRevision: revision });
    });

    await expect(
      requestDeploymentPromote(loadTestConfig(agent), "worker", revision, fetchImpl, async (milliseconds) => {
        sleeps.push(milliseconds);
      }),
    ).resolves.toEqual({
      ok: true,
      release: revision,
      currentRevision: revision,
    });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([5_000]);
  });

  it("does not retry a stale deployment request", async () => {
    let attempts = 0;
    const fetchImpl = mock(async () => {
      attempts += 1;
      return Response.json({ ok: false, message: "This button belongs to an older source release." }, { status: 409 });
    });

    await expect(requestDeploymentPromote(loadTestConfig(agent), "worker", revision, fetchImpl, async () => {})).resolves.toEqual({
      ok: false,
      message: "This button belongs to an older source release.",
    });
    expect(attempts).toBe(1);
  });
});
