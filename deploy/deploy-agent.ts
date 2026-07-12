import { timingSafeEqual } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

type Release = { image: string; revision: string; deployedAt: string };
type DeploymentState = { current?: Release; previous?: Release; lastFailure?: { revision: string; message: string; at: string } };

const config = {
  host: Bun.env.DEPLOY_AGENT_HOST ?? "172.17.0.1",
  port: Number(Bun.env.DEPLOY_AGENT_PORT ?? "9899"),
  token: required("DEPLOY_AGENT_TOKEN"),
  composeFile: required("DEPLOY_COMPOSE_FILE"),
  imageEnvFile: required("DEPLOY_IMAGE_ENV_FILE"),
  stateFile: Bun.env.DEPLOY_STATE_FILE ?? "/var/lib/alexgetman-deploy/state.json",
  healthUrl: Bun.env.DEPLOY_HEALTH_URL ?? "http://127.0.0.1:8788/readyz",
  container: Bun.env.DEPLOY_CONTAINER_NAME ?? "alexgetman-backend",
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

function composeArgs(...args: string[]): string[] {
  return ["compose", "--env-file", config.imageEnvFile, "-f", config.composeFile, ...args];
}

async function state(): Promise<DeploymentState> {
  const file = Bun.file(config.stateFile);
  if (!(await file.exists())) return {};
  const parsed = await file.json().catch(() => null);
  return parsed && typeof parsed === "object" ? (parsed as DeploymentState) : {};
}

async function writeState(value: DeploymentState): Promise<void> {
  await mkdir(dirname(config.stateFile), { recursive: true });
  await Bun.write(config.stateFile, `${JSON.stringify(value, null, 2)}\n`);
}

async function currentImage(): Promise<string | undefined> {
  const env = await Bun.file(config.imageEnvFile)
    .text()
    .catch(() => "");
  const declared = env.match(/^BACKEND_IMAGE=(.+)$/m)?.[1]?.trim();
  if (immutableImage(declared)) return declared;
  const repoDigest = await command(["image", "inspect", "--format", "{{index .RepoDigests 0}}", config.container], true);
  return immutableImage(repoDigest) ? repoDigest : undefined;
}

async function writeImage(image: string): Promise<void> {
  const temporary = `${config.imageEnvFile}.next`;
  const existing = await Bun.file(config.imageEnvFile)
    .text()
    .catch(() => "");
  const preserved = existing
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("BACKEND_IMAGE="))
    .filter(Boolean);
  await Bun.write(temporary, [`BACKEND_IMAGE=${image}`, ...preserved, ""].join("\n"));
  await rename(temporary, config.imageEnvFile);
}

async function waitForHealthy(): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last = "container did not become ready";
  while (Date.now() < deadline) {
    const health = await command(
      ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", config.container],
      true,
    );
    if (health === "unhealthy" || health === "exited" || health === "dead") throw new Error(`container state is ${health}`);
    try {
      const response = await fetch(config.healthUrl, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      last = `readyz returned ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`health check timeout: ${last}`);
}

async function activate(image: string): Promise<void> {
  await writeImage(image);
  await command(composeArgs("pull", "backend"));
  await command(composeArgs("up", "-d", "--no-deps", "--force-recreate", "backend"));
  await waitForHealthy();
}

async function notify(text: string, release?: string): Promise<void> {
  if (!config.notificationToken || !config.notificationChatId) return;
  const reply_markup = release ? { inline_keyboard: [[{ text: "Откатить", callback_data: `deploy_rollback:${release}` }]] } : undefined;
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

async function deploy(image: string, release: string): Promise<DeploymentState> {
  return withDeploymentLock(async () => {
    const previousImage = await currentImage();
    if (!previousImage)
      throw new HttpError(409, "Current release is not an immutable GHCR digest; seed DEPLOY_IMAGE_ENV_FILE before deploying.");
    const previousState = await state();
    const previous: Release = previousState.current ?? {
      image: previousImage,
      revision: previousImage.slice(-12),
      deployedAt: new Date().toISOString(),
    };
    try {
      await activate(image);
      const next = { current: { image, revision: release, deployedAt: new Date().toISOString() }, previous };
      await writeState(next);
      await notify(`Deploy ${release.slice(0, 12)} successful and healthy.`, release);
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await activate(previousImage);
      } catch (rollbackError) {
        throw new HttpError(500, `Deploy failed (${message}); automatic rollback also failed: ${String(rollbackError)}`);
      }
      const next = { ...previousState, current: previous, lastFailure: { revision: release, message, at: new Date().toISOString() } };
      await writeState(next);
      await notify(`Deploy ${release.slice(0, 12)} failed; automatic rollback to ${previous.revision.slice(0, 12)} succeeded.`);
      throw new HttpError(502, `Deploy failed and was rolled back: ${message}`);
    }
  });
}

async function rollback(release: string): Promise<DeploymentState> {
  return withDeploymentLock(async () => {
    const before = await state();
    if (!before.current || !before.previous) throw new HttpError(409, "No rollback release is available.");
    if (before.current.revision !== release) throw new HttpError(409, "This rollback button belongs to an older release.");
    try {
      await activate(before.previous.image);
    } catch (error) {
      throw new HttpError(502, `Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const next = { current: { ...before.previous, deployedAt: new Date().toISOString() }, previous: before.current };
    await writeState(next);
    await notify(`Manual rollback to ${next.current.revision.slice(0, 12)} successful and healthy.`, next.current.revision);
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
    if (request.method === "POST" && url.pathname === "/v1/deploy") {
      if (!immutableImage(body?.image) || !revision(body?.release))
        throw new HttpError(400, "image must be an immutable configured GHCR digest and release must be a Git SHA.");
      const next = await deploy(body.image, body.release);
      return json({ ok: true, release: next.current?.revision, currentRevision: next.current?.revision });
    }
    if (request.method === "POST" && url.pathname === "/v1/rollback") {
      if (!revision(body?.release)) throw new HttpError(400, "release must be a Git SHA.");
      const next = await rollback(body.release);
      return json({ ok: true, release: next.current?.revision, currentRevision: next.current?.revision });
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
