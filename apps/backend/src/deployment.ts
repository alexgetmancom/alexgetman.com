import type { BackendConfig } from "./config.js";

// Telegram callback_data is limited to 64 bytes. "deploy_rollback:" leaves
// room for a normal 40-character Git SHA with a small safety margin.
const releasePattern = /^[a-f0-9]{7,40}$/i;

type DeploymentRollbackResult = { ok: true; release: string; currentRevision: string } | { ok: false; message: string };
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function deploymentRollbackCallback(revision: string): string {
  if (!releasePattern.test(revision)) throw new Error("deployment revision must be a Git SHA");
  return `deploy_rollback:${revision}`;
}

export function isDeploymentRollbackCallback(value: string): value is `deploy_rollback:${string}` {
  const [action, revision, extra] = value.split(":");
  return action === "deploy_rollback" && extra === undefined && revision !== undefined && releasePattern.test(revision);
}

export async function requestDeploymentRollback(
  config: BackendConfig,
  revision: string,
  fetchImpl: FetchImplementation = fetch,
): Promise<DeploymentRollbackResult> {
  if (!config.DEPLOY_AGENT_URL || !config.DEPLOY_AGENT_TOKEN) return { ok: false, message: "Deployment agent is not configured." };
  if (!releasePattern.test(revision)) return { ok: false, message: "Invalid deployment revision." };
  try {
    const response = await fetchImpl(`${config.DEPLOY_AGENT_URL.replace(/\/$/, "")}/v1/rollback`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.DEPLOY_AGENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ release: revision }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      release?: unknown;
      currentRevision?: unknown;
      message?: unknown;
    } | null;
    if (!response.ok || body?.ok !== true || typeof body.release !== "string" || typeof body.currentRevision !== "string") {
      return { ok: false, message: typeof body?.message === "string" ? body.message : `Rollback failed (${response.status}).` };
    }
    return { ok: true, release: body.release, currentRevision: body.currentRevision };
  } catch {
    return { ok: false, message: "Deployment agent is unavailable." };
  }
}
