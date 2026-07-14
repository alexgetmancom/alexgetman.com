import type { BackendConfig } from "./config.js";

// Telegram callback_data is limited to 64 bytes. "deploy_rollback:" plus a
// seven-character profile name leaves room for a normal 40-character Git SHA.
const releasePattern = /^[a-f0-9]{7,40}$/i;
const targetPattern = /^[a-z][a-z0-9_-]{0,6}$/;

type DeploymentRollbackResult = { ok: true; release: string; currentRevision: string } | { ok: false; message: string };
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type DeploymentRollback = { target: string; revision: string };

export function deploymentRollbackCallback(target: string, revision: string): string {
  if (!targetPattern.test(target)) throw new Error("deployment target must be a short lowercase identifier");
  if (!releasePattern.test(revision)) throw new Error("deployment revision must be a Git SHA");
  return `deploy_rollback:${target}:${revision}`;
}

export function parseDeploymentRollbackCallback(value: string): DeploymentRollback | null {
  const [action, target, revision, extra] = value.split(":");
  if (action !== "deploy_rollback" || extra !== undefined || !target || !revision) return null;
  return targetPattern.test(target) && releasePattern.test(revision) ? { target, revision } : null;
}

export async function requestDeploymentRollback(
  config: BackendConfig,
  target: string,
  revision: string,
  fetchImpl: FetchImplementation = fetch,
): Promise<DeploymentRollbackResult> {
  if (!config.DEPLOY_AGENT_URL || !config.DEPLOY_AGENT_TOKEN) return { ok: false, message: "Deployment agent is not configured." };
  if (!targetPattern.test(target) || !releasePattern.test(revision)) return { ok: false, message: "Invalid deployment rollback request." };
  try {
    const response = await fetchImpl(`${config.DEPLOY_AGENT_URL.replace(/\/$/, "")}/v1/rollback/${target}`, {
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
