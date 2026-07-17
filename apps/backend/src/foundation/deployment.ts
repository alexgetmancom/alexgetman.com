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
  return parseDeploymentCallback(value, "deploy_rollback");
}

export function deploymentPromoteCallback(target: string, revision: string): string {
  if (!targetPattern.test(target)) throw new Error("deployment target must be a short lowercase identifier");
  if (!releasePattern.test(revision)) throw new Error("deployment revision must be a Git SHA");
  return `deploy_promote:${target}:${revision}`;
}

export function parseDeploymentPromoteCallback(value: string): DeploymentRollback | null {
  return parseDeploymentCallback(value, "deploy_promote");
}

// Ask-then-confirm callbacks. Kept under a short prefix (not "deploy_rollback_ask")
// so the 64-byte callback_data budget still fits a full 40-character Git SHA.
export function parseDeploymentRollbackAskCallback(value: string): DeploymentRollback | null {
  return parseDeploymentCallback(value, "deploy_rb_ask");
}

export function parseDeploymentPromoteAskCallback(value: string): DeploymentRollback | null {
  return parseDeploymentCallback(value, "deploy_pr_ask");
}

function parseDeploymentCallback(value: string, action: string): DeploymentRollback | null {
  const [receivedAction, target, revision, extra] = value.split(":");
  if (receivedAction !== action || extra !== undefined || !target || !revision) return null;
  return targetPattern.test(target) && releasePattern.test(revision) ? { target, revision } : null;
}

export async function requestDeploymentRollback(
  config: BackendConfig,
  target: string,
  revision: string,
  fetchImpl: FetchImplementation = fetch,
): Promise<DeploymentRollbackResult> {
  return requestDeploymentAgent(config, "rollback", target, revision, fetchImpl);
}

/** Deploys to `target` the exact release already proven healthy on alex.
 * Only "alex" is auto-deployed by CI; every other target is promoted manually
 * from here so a vetted release never cascades to another environment unseen. */
export async function requestDeploymentPromote(
  config: BackendConfig,
  target: string,
  revision: string,
  fetchImpl: FetchImplementation = fetch,
): Promise<DeploymentRollbackResult> {
  return requestDeploymentAgent(config, "promote", target, revision, fetchImpl);
}

async function requestDeploymentAgent(
  config: BackendConfig,
  action: "rollback" | "promote",
  target: string,
  revision: string,
  fetchImpl: FetchImplementation,
): Promise<DeploymentRollbackResult> {
  if (!config.DEPLOY_AGENT_URL || !config.DEPLOY_AGENT_TOKEN) return { ok: false, message: "Deployment agent is not configured." };
  if (!targetPattern.test(target) || !releasePattern.test(revision)) return { ok: false, message: "Invalid deployment request." };
  try {
    const response = await fetchImpl(`${config.DEPLOY_AGENT_URL.replace(/\/$/, "")}/v1/${action}/${target}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.DEPLOY_AGENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ release: revision }),
      // The agent's own healthcheck loop alone runs up to 90s; leave enough
      // margin for the image pull and container recreate around it so a slow
      // deploy reports its real outcome instead of a false "unavailable".
      signal: AbortSignal.timeout(150_000),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      release?: unknown;
      currentRevision?: unknown;
      message?: unknown;
    } | null;
    if (!response.ok || body?.ok !== true || typeof body.release !== "string" || typeof body.currentRevision !== "string") {
      return { ok: false, message: typeof body?.message === "string" ? body.message : `Request failed (${response.status}).` };
    }
    return { ok: true, release: body.release, currentRevision: body.currentRevision };
  } catch {
    return { ok: false, message: "Deployment agent is unavailable." };
  }
}
