import { describe, expect, it, mock } from "bun:test";
import { loadConfig } from "../src/config.js";
import { deploymentRollbackCallback, parseDeploymentRollbackCallback, requestDeploymentRollback } from "../src/deployment.js";

describe("deployment rollback protocol", () => {
  const revision = "a".repeat(40);

  it("only generates compact callbacks for Git SHAs", () => {
    expect(deploymentRollbackCallback("maru", revision)).toBe(`deploy_rollback:maru:${revision}`);
    expect(parseDeploymentRollbackCallback(`deploy_rollback:maru:${revision}`)).toEqual({ target: "maru", revision });
    expect(parseDeploymentRollbackCallback("deploy_rollback:maru:latest")).toBeNull();
    expect(() => deploymentRollbackCallback("maru", "latest")).toThrow("Git SHA");
  });

  it("forwards an authenticated rollback request to the private agent", async () => {
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://host.docker.internal:9899/v1/rollback/maru");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${"t".repeat(16)}` });
      expect(init?.body).toBe(JSON.stringify({ release: revision }));
      return Response.json({ ok: true, release: revision, currentRevision: "b".repeat(40) });
    });
    await expect(
      requestDeploymentRollback(
        loadConfig({ DEPLOY_AGENT_URL: "http://host.docker.internal:9899", DEPLOY_AGENT_TOKEN: "t".repeat(16) }),
        "maru",
        revision,
        fetchImpl,
      ),
    ).resolves.toEqual({ ok: true, release: revision, currentRevision: "b".repeat(40) });
  });

  it("does not issue network requests when deployment control is disabled", async () => {
    const fetchImpl = mock(fetch);
    await expect(requestDeploymentRollback(loadConfig({}), "maru", revision, fetchImpl)).resolves.toEqual({
      ok: false,
      message: "Deployment agent is not configured.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
