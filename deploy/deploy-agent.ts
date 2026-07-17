import { timingSafeEqual } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

type Release = { image: string; revision: string; deployedAt: string };
type DeploymentState = { current?: Release; previous?: Release; lastFailure?: { revision: string; message: string; at: string } };
type DeploymentTarget = {
  name: string;
  composeFile: string;
  imageEnvFile: string;
  stateFile: string;
  healthUrl: string;
  container: string;
};

const config = {
  host: Bun.env.DEPLOY_AGENT_HOST ?? "172.17.0.1",
  port: Number(Bun.env.DEPLOY_AGENT_PORT ?? "9899"),
  token: required("DEPLOY_AGENT_TOKEN"),
  repository: Bun.env.DEPLOY_IMAGE_REPOSITORY ?? "ghcr.io/alexgetmancom/alexgetman-backend",
  notificationToken: Bun.env.DEPLOY_NOTIFICATION_BOT_TOKEN ?? Bun.env.CONTROLLER_BOT_TOKEN ?? Bun.env.TELEGRAM_BOT_TOKEN,
  notificationChatId: Bun.env.DEPLOY_NOTIFICATION_CHAT_ID,
  notificationApiBaseUrl: Bun.env.DEPLOY_NOTIFICATION_API_BASE_URL ?? "http://127.0.0.1:8081",
};

let deploying = false;

function required(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function immutableImage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(`${config.repository}@sha256:`) &&
    /^[a-f0-9]{64}$/i.test(value.slice(value.lastIndexOf(":") + 1))
  );
}

function revision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{7,40}$/i.test(value);
}

function deploymentTargets(): Map<string, DeploymentTarget> {
  const configured = Bun.env.DEPLOY_TARGETS_JSON?.trim();
  if (!configured) {
    const target: DeploymentTarget = {
      name: "alex",
      composeFile: required("DEPLOY_COMPOSE_FILE"),
      imageEnvFile: required("DEPLOY_IMAGE_ENV_FILE"),
      stateFile: Bun.env.DEPLOY_STATE_FILE ?? "/var/lib/alexgetman-deploy/state.json",
      healthUrl: Bun.env.DEPLOY_HEALTH_URL ?? "http://127.0.0.1:8788/readyz",
      container: Bun.env.DEPLOY_CONTAINER_NAME ?? "alexgetman-backend",
    };
    return new Map([[target.name, target]]);
  }
  const parsed = JSON.parse(configured) as Record<string, Omit<DeploymentTarget, "name">>;
  const targets = new Map<string, DeploymentTarget>();
  for (const [name, value] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9_-]{0,6}$/.test(name)) throw new Error(`Invalid deployment target name: ${name}`);
    if (!value || typeof value !== "object") throw new Error(`Invalid deployment target: ${name}`);
    for (const key of ["composeFile", "imageEnvFile", "stateFile", "healthUrl", "container"] as const) {
      if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`Deployment target ${name} is missing ${key}`);
    }
    targets.set(name, { name, ...value });
  }
  if (targets.size === 0) throw new Error("DEPLOY_TARGETS_JSON must configure at least one target.");
  return targets;
}

const targets = deploymentTargets();

function target(name: string | undefined): DeploymentTarget {
  const selected = targets.get(name ?? "alex");
  if (!selected) throw new HttpError(404, `Unknown deployment target: ${name ?? "alex"}`);
  return selected;
}

async function command(args: string[], allowFailure = false): Promise<string> {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0 && !allowFailure) throw new Error(stderr.trim() || `docker ${args.join(" ")} exited with ${code}`);
  return stdout.trim();
}

function composeArgs(deploymentTarget: DeploymentTarget, ...args: string[]): string[] {
  return ["compose", "--env-file", deploymentTarget.imageEnvFile, "-f", deploymentTarget.composeFile, ...args];
}

async function state(deploymentTarget: DeploymentTarget): Promise<DeploymentState> {
  const file = Bun.file(deploymentTarget.stateFile);
  if (!(await file.exists())) return {};
  const parsed = await file.json().catch(() => null);
  return parsed && typeof parsed === "object" ? (parsed as DeploymentState) : {};
}

async function writeState(deploymentTarget: DeploymentTarget, value: DeploymentState): Promise<void> {
  await mkdir(dirname(deploymentTarget.stateFile), { recursive: true });
  await Bun.write(deploymentTarget.stateFile, `${JSON.stringify(value, null, 2)}\n`);
}

async function currentImage(deploymentTarget: DeploymentTarget): Promise<string | undefined> {
  const env = await Bun.file(deploymentTarget.imageEnvFile)
    .text()
    .catch(() => "");
  const declared = env.match(/^BACKEND_IMAGE=(.+)$/m)?.[1]?.trim();
  if (immutableImage(declared)) return declared;
  const repoDigest = await command(["image", "inspect", "--format", "{{index .RepoDigests 0}}", deploymentTarget.container], true);
  return immutableImage(repoDigest) ? repoDigest : undefined;
}

async function writeImage(deploymentTarget: DeploymentTarget, image: string): Promise<void> {
  const temporary = `${deploymentTarget.imageEnvFile}.next`;
  const existing = await Bun.file(deploymentTarget.imageEnvFile)
    .text()
    .catch(() => "");
  const preserved = existing
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("BACKEND_IMAGE="))
    .filter(Boolean);
  await Bun.write(temporary, [`BACKEND_IMAGE=${image}`, ...preserved, ""].join("\n"));
  await rename(temporary, deploymentTarget.imageEnvFile);
}

async function waitForHealthy(deploymentTarget: DeploymentTarget): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last = "container did not become ready";
  while (Date.now() < deadline) {
    const health = await command(
      ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", deploymentTarget.container],
      true,
    );
    if (health === "unhealthy" || health === "exited" || health === "dead") throw new Error(`container state is ${health}`);
    try {
      const response = await fetch(deploymentTarget.healthUrl, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      last = `readyz returned ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`health check timeout: ${last}`);
}

async function activate(deploymentTarget: DeploymentTarget, image: string): Promise<void> {
  await writeImage(deploymentTarget, image);
  await command(composeArgs(deploymentTarget, "pull", "backend"));
  await command(composeArgs(deploymentTarget, "up", "-d", "--no-deps", "--force-recreate", "backend"));
  await waitForHealthy(deploymentTarget);
}

async function notify(text: string, deploymentTarget: DeploymentTarget, release?: string, offerPromoteTo?: string): Promise<void> {
  if (!config.notificationToken || !config.notificationChatId) return;
  const buttons: { text: string; callback_data: string }[][] = [];
  if (release)
    buttons.push([{ text: `Откатить ${deploymentTarget.name}`, callback_data: `deploy_rollback:${deploymentTarget.name}:${release}` }]);
  if (release && offerPromoteTo)
    buttons.push([{ text: `Раскатить ${offerPromoteTo}`, callback_data: `deploy_promote:${offerPromoteTo}:${release}` }]);
  const reply_markup = buttons.length > 0 ? { inline_keyboard: buttons } : undefined;
  await fetch(`${config.notificationApiBaseUrl.replace(/\/$/, "")}/bot${config.notificationToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.notificationChatId, text, ...(reply_markup ? { reply_markup } : {}) }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

async function withDeploymentLock<T>(operation: () => Promise<T>): Promise<T> {
  if (deploying) throw new HttpError(409, "A deployment is already running.");
  deploying = true;
  try {
    return await operation();
  } finally {
    deploying = false;
  }
}

async function deploy(deploymentTarget: DeploymentTarget, image: string, release: string): Promise<DeploymentState> {
  return withDeploymentLock(async () => {
    const previousImage = await currentImage(deploymentTarget);
    if (!previousImage)
      throw new HttpError(409, "Current release is not an immutable GHCR digest; seed DEPLOY_IMAGE_ENV_FILE before deploying.");
    const previousState = await state(deploymentTarget);
    const previous: Release = previousState.current ?? {
      image: previousImage,
      revision: previousImage.slice(-12),
      deployedAt: new Date().toISOString(),
    };
    try {
      await activate(deploymentTarget, image);
      const next = { current: { image, revision: release, deployedAt: new Date().toISOString() }, previous };
      await writeState(deploymentTarget, next);
      await notify(
        `Deploy ${deploymentTarget.name} ${release.slice(0, 12)} successful and healthy.`,
        deploymentTarget,
        release,
        promotionCandidate(deploymentTarget),
      );
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await activate(deploymentTarget, previousImage);
      } catch (rollbackError) {
        throw new HttpError(500, `Deploy failed (${message}); automatic rollback also failed: ${String(rollbackError)}`);
      }
      const next = { ...previousState, current: previous, lastFailure: { revision: release, message, at: new Date().toISOString() } };
      await writeState(deploymentTarget, next);
      await notify(
        `Deploy ${deploymentTarget.name} ${release.slice(0, 12)} failed; automatic rollback to ${previous.revision.slice(0, 12)} succeeded.`,
        deploymentTarget,
      );
      throw new HttpError(502, `Deploy failed and was rolled back: ${message}`);
    }
  });
}

/** Only "alex" is ever auto-deployed by CI; every other configured target is
 * deployed manually, by promoting the exact image alex just proved healthy. */
function promotionCandidate(deploymentTarget: DeploymentTarget): string | undefined {
  if (deploymentTarget.name !== "alex") return undefined;
  const others = [...targets.keys()].filter((name) => name !== "alex");
  return others.length === 1 ? others[0] : undefined;
}

async function promote(sourceTarget: DeploymentTarget, destTarget: DeploymentTarget, release: string): Promise<DeploymentState> {
  const sourceState = await state(sourceTarget);
  if (sourceState.current?.revision !== release) throw new HttpError(409, "This button belongs to an older alex release.");
  return deploy(destTarget, sourceState.current.image, release);
}

async function rollback(deploymentTarget: DeploymentTarget, release: string): Promise<DeploymentState> {
  return withDeploymentLock(async () => {
    const before = await state(deploymentTarget);
    if (!before.current || !before.previous) throw new HttpError(409, "No rollback release is available.");
    if (before.current.revision !== release) throw new HttpError(409, "This rollback button belongs to an older release.");
    try {
      await activate(deploymentTarget, before.previous.image);
    } catch (error) {
      throw new HttpError(502, `Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const next = { current: { ...before.previous, deployedAt: new Date().toISOString() }, previous: before.current };
    await writeState(deploymentTarget, next);
    await notify(
      `Manual rollback of ${deploymentTarget.name} to ${next.current.revision.slice(0, 12)} successful and healthy.`,
      deploymentTarget,
      next.current.revision,
    );
    return next;
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function requestHandler(request: Request): Promise<Response> {
  if (request.method === "GET" && new URL(request.url).pathname === "/healthz") return json({ ok: true, deploying });
  const received = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!constantTimeEqual(received, config.token)) return json({ ok: false, message: "forbidden" }, 403);
  try {
    const url = new URL(request.url);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const [, , action, requestedTarget] = url.pathname.split("/");
    const deploymentTarget = target(requestedTarget);
    if (request.method === "POST" && action === "deploy") {
      if (!immutableImage(body?.image) || !revision(body?.release))
        throw new HttpError(400, "image must be an immutable configured GHCR digest and release must be a Git SHA.");
      const next = await deploy(deploymentTarget, body.image, body.release);
      return json({ ok: true, target: deploymentTarget.name, release: next.current?.revision, currentRevision: next.current?.revision });
    }
    if (request.method === "POST" && action === "rollback") {
      if (!revision(body?.release)) throw new HttpError(400, "release must be a Git SHA.");
      const next = await rollback(deploymentTarget, body.release);
      return json({ ok: true, target: deploymentTarget.name, release: next.current?.revision, currentRevision: next.current?.revision });
    }
    if (request.method === "POST" && action === "promote") {
      if (!revision(body?.release)) throw new HttpError(400, "release must be a Git SHA.");
      const next = await promote(target("alex"), deploymentTarget, body.release);
      return json({ ok: true, target: deploymentTarget.name, release: next.current?.revision, currentRevision: next.current?.revision });
    }
    return json({ ok: false, message: "not found" }, 404);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, message }, status);
  }
}

function serve(hostname: string): void {
  Bun.serve({ hostname, port: config.port, fetch: requestHandler });
  console.log(JSON.stringify({ level: "info", message: "deploy agent listening", host: hostname, port: config.port }));
}

serve("127.0.0.1");
if (config.host !== "127.0.0.1") serve(config.host);
