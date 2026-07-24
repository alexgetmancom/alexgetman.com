import { timingSafeEqual } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

type Release = { image: string; revision: string; deployedAt: string };
type DeploymentState = {
  current?: Release;
  previous?: Release;
  lastFailure?: { revision: string; message: string; at: string };
};
type DeploymentTarget = {
  name: string;
  composeFile: string;
  imageEnvFile: string;
  stateFile: string;
  healthUrl: string;
  container: string;
  service: string;
  imageEnvKey: string;
  remoteUrl?: string;
  remoteToken?: string;
  artifactFile?: string;
  repository?: string;
  /** First rollout has no trustworthy immutable image to roll back to. */
  allowInitialSeed?: boolean;
};

const config = {
  host: Bun.env.DEPLOY_AGENT_HOST ?? "172.17.0.1",
  port: Number(Bun.env.DEPLOY_AGENT_PORT ?? "9899"),
  token: required("DEPLOY_AGENT_TOKEN"),
  repository: Bun.env.DEPLOY_IMAGE_REPOSITORY ?? "ghcr.io/alexgetmancom/alexgetman-backend",
  defaultTarget: Bun.env.DEPLOY_DEFAULT_TARGET ?? "alex",
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

function immutableImage(value: unknown, repository = config.repository): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(`${repository}@sha256:`) &&
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
      name: config.defaultTarget,
      composeFile: required("DEPLOY_COMPOSE_FILE"),
      imageEnvFile: required("DEPLOY_IMAGE_ENV_FILE"),
      stateFile: Bun.env.DEPLOY_STATE_FILE ?? "/var/lib/alexgetman-deploy/state.json",
      healthUrl: Bun.env.DEPLOY_HEALTH_URL ?? "http://127.0.0.1:8788/readyz",
      container: Bun.env.DEPLOY_CONTAINER_NAME ?? "alexgetman-backend",
      service: Bun.env.DEPLOY_SERVICE_NAME ?? "backend",
      imageEnvKey: Bun.env.DEPLOY_IMAGE_ENV_KEY ?? "BACKEND_IMAGE",
      allowInitialSeed: Bun.env.DEPLOY_ALLOW_INITIAL_SEED === "true",
    };
    return new Map([[target.name, target]]);
  }
  const parsed = JSON.parse(configured) as Record<string, Omit<DeploymentTarget, "name">>;
  const targets = new Map<string, DeploymentTarget>();
  for (const [name, value] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9_-]{0,6}$/.test(name)) throw new Error(`Invalid deployment target name: ${name}`);
    if (!value || typeof value !== "object") throw new Error(`Invalid deployment target: ${name}`);
    for (const key of ["stateFile"] as const) {
      if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`Deployment target ${name} is missing ${key}`);
    }
    if (value.remoteUrl) {
      if (
        typeof value.remoteUrl !== "string" ||
        typeof value.remoteToken !== "string" ||
        typeof value.artifactFile !== "string" ||
        typeof value.repository !== "string"
      )
        throw new Error(`Remote deployment target ${name} requires remoteUrl, remoteToken, artifactFile and repository`);
      targets.set(name, {
        ...value,
        name,
        service: value.service ?? "",
        imageEnvKey: value.imageEnvKey ?? "",
      });
      continue;
    }
    for (const key of ["composeFile", "imageEnvFile", "healthUrl", "container"] as const) {
      if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`Deployment target ${name} is missing ${key}`);
    }
    targets.set(name, {
      ...value,
      name,
      service: value.service ?? "backend",
      imageEnvKey: value.imageEnvKey ?? "BACKEND_IMAGE",
    });
  }
  if (targets.size === 0) throw new Error("DEPLOY_TARGETS_JSON must configure at least one target.");
  return targets;
}

const targets = deploymentTargets();

function target(name: string | undefined): DeploymentTarget {
  const selected = targets.get(name ?? config.defaultTarget);
  if (!selected) throw new HttpError(404, `Unknown deployment target: ${name ?? config.defaultTarget}`);
  return selected;
}

async function command(args: string[], allowFailure = false): Promise<string> {
  const process = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
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
  if (deploymentTarget.remoteUrl) return (await state(deploymentTarget)).current?.image;
  const env = await Bun.file(deploymentTarget.imageEnvFile)
    .text()
    .catch(() => "");
  const declared = env.match(new RegExp(`^${deploymentTarget.imageEnvKey}=(.+)$`, "m"))?.[1]?.trim();
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
    .filter((line) => !line.startsWith(`${deploymentTarget.imageEnvKey}=`))
    .filter(Boolean);
  await Bun.write(temporary, [`${deploymentTarget.imageEnvKey}=${image}`, ...preserved, ""].join("\n"));
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
      const response = await fetch(deploymentTarget.healthUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
      last = `readyz returned ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`health check timeout: ${last}`);
}

async function activate(deploymentTarget: DeploymentTarget, image: string, release: string): Promise<void> {
  if (deploymentTarget.remoteUrl) {
    const response = await fetch(`${deploymentTarget.remoteUrl.replace(/\/$/, "")}/v1/deploy`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deploymentTarget.remoteToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ image, release }),
      signal: AbortSignal.timeout(150_000),
    });
    if (!response.ok) throw new Error(`remote deploy failed (${response.status}): ${(await response.text()).slice(0, 400)}`);
    return;
  }
  await writeImage(deploymentTarget, image);
  await command(composeArgs(deploymentTarget, "pull", deploymentTarget.service));
  await command(composeArgs(deploymentTarget, "up", "-d", "--no-deps", "--force-recreate", deploymentTarget.service));
  await waitForHealthy(deploymentTarget);
}

/** Preserve a hand-managed predecessor during the one-time Compose cutover. */
async function parkLegacyContainer(deploymentTarget: DeploymentTarget): Promise<string | undefined> {
  if (deploymentTarget.remoteUrl) return undefined;
  const id = await command(["container", "inspect", "--format", "{{.Id}}", deploymentTarget.container], true);
  if (!id) return undefined;
  const legacy = `${deploymentTarget.container}-legacy-${Date.now()}`;
  await command(["stop", deploymentTarget.container]);
  await command(["rename", deploymentTarget.container, legacy]);
  return legacy;
}

async function restoreLegacyContainer(deploymentTarget: DeploymentTarget, legacy: string): Promise<void> {
  await command(["rm", "-f", deploymentTarget.container], true);
  await command(["rename", legacy, deploymentTarget.container]);
  await command(["start", deploymentTarget.container]);
}

async function notify(text: string, deploymentTarget: DeploymentTarget, release?: string, offerPromoteTo?: string[]): Promise<void> {
  if (!config.notificationToken || !config.notificationChatId) return;
  const buttons: { text: string; callback_data: string }[][] = [];
  // The bot asks for confirmation before actually acting, so these point at
  // the short "_ask" callbacks rather than the ones that execute directly.
  if (release)
    buttons.push([
      {
        text: `Откатить ${deploymentTarget.name}`,
        callback_data: `deploy_rb_ask:${deploymentTarget.name}:${release}`,
      },
    ]);
  if (release)
    for (const promoteTarget of offerPromoteTo ?? [])
      buttons.push([
        {
          text: `Раскатить ${promoteTarget}`,
          callback_data: `deploy_pr_ask:${promoteTarget}:${release}`,
        },
      ]);
  const reply_markup = buttons.length > 0 ? { inline_keyboard: buttons } : undefined;
  await fetch(`${config.notificationApiBaseUrl.replace(/\/$/, "")}/bot${config.notificationToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.notificationChatId,
      text,
      ...(reply_markup ? { reply_markup } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error) =>
    console.error(
      JSON.stringify({
        level: "error",
        message: "deploy notify failed",
        error: String(error),
      }),
    ),
  );
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
    if (!previousImage && !deploymentTarget.allowInitialSeed)
      throw new HttpError(409, "Current release is not an immutable GHCR digest; seed DEPLOY_IMAGE_ENV_FILE before deploying.");
    const previousState = await state(deploymentTarget);
    const previous: Release | undefined = previousImage
      ? (previousState.current ?? {
          image: previousImage,
          revision: previousImage.slice(-12),
          deployedAt: new Date().toISOString(),
        })
      : undefined;
    let legacyContainer: string | undefined;
    try {
      if (!previous) legacyContainer = await parkLegacyContainer(deploymentTarget);
      await activate(deploymentTarget, image, release);
      const next = {
        current: {
          image,
          revision: release,
          deployedAt: new Date().toISOString(),
        },
        ...(previous ? { previous } : {}),
      };
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
      if (!previous) {
        const next = {
          ...previousState,
          lastFailure: {
            revision: release,
            message,
            at: new Date().toISOString(),
          },
        };
        await writeState(deploymentTarget, next);
        if (legacyContainer) {
          try {
            await restoreLegacyContainer(deploymentTarget, legacyContainer);
          } catch (restoreError) {
            throw new HttpError(500, `Initial deploy failed (${message}); legacy restore also failed: ${String(restoreError)}`);
          }
        }
        throw new HttpError(502, `Initial deploy failed and has no prior immutable image to roll back to: ${message}`);
      }
      try {
        await activate(deploymentTarget, previous.image, previous.revision);
      } catch (rollbackError) {
        throw new HttpError(500, `Deploy failed (${message}); automatic rollback also failed: ${String(rollbackError)}`);
      }
      const next = {
        ...previousState,
        current: previous,
        lastFailure: {
          revision: release,
          message,
          at: new Date().toISOString(),
        },
      };
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
function promotionCandidate(deploymentTarget: DeploymentTarget): string[] {
  if (deploymentTarget.name !== config.defaultTarget) return [];
  return [...targets.keys()].filter((name) => name !== config.defaultTarget);
}

async function promote(sourceTarget: DeploymentTarget, destTarget: DeploymentTarget, release: string): Promise<DeploymentState> {
  const sourceState = await state(sourceTarget);
  if (sourceState.current?.revision !== release) throw new HttpError(409, "This button belongs to an older source release.");
  if (!destTarget.remoteUrl) return deploy(destTarget, sourceState.current.image, release);
  const artifact = (await Bun.file(destTarget.artifactFile as string)
    .json()
    .catch(() => null)) as { image?: unknown; release?: unknown } | null;
  if (!artifact || artifact.release !== release || !immutableImage(artifact.image, destTarget.repository))
    throw new HttpError(409, `No immutable remote artifact is registered for ${release}.`);
  return deploy(destTarget, artifact.image, release);
}

async function rollback(deploymentTarget: DeploymentTarget, release: string): Promise<DeploymentState> {
  return withDeploymentLock(async () => {
    const before = await state(deploymentTarget);
    if (!before.current || !before.previous) throw new HttpError(409, "No rollback release is available.");
    if (before.current.revision !== release) throw new HttpError(409, "This rollback button belongs to an older release.");
    try {
      await activate(deploymentTarget, before.previous.image, before.previous.revision);
    } catch (error) {
      throw new HttpError(502, `Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const next = {
      current: { ...before.previous, deployedAt: new Date().toISOString() },
      previous: before.current,
    };
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
      return json({
        ok: true,
        target: deploymentTarget.name,
        release: next.current?.revision,
        currentRevision: next.current?.revision,
      });
    }
    if (request.method === "POST" && action === "rollback") {
      if (!revision(body?.release)) throw new HttpError(400, "release must be a Git SHA.");
      const next = await rollback(deploymentTarget, body.release);
      return json({
        ok: true,
        target: deploymentTarget.name,
        release: next.current?.revision,
        currentRevision: next.current?.revision,
      });
    }
    if (request.method === "POST" && action === "promote") {
      if (!revision(body?.release)) throw new HttpError(400, "release must be a Git SHA.");
      const next = await promote(target(config.defaultTarget), deploymentTarget, body.release);
      return json({
        ok: true,
        target: deploymentTarget.name,
        release: next.current?.revision,
        currentRevision: next.current?.revision,
      });
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
  console.log(
    JSON.stringify({
      level: "info",
      message: "deploy agent listening",
      host: hostname,
      port: config.port,
    }),
  );
}

serve("127.0.0.1");
if (config.host !== "127.0.0.1") serve(config.host);
