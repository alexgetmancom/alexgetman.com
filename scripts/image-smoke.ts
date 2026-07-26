import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { devFixture, seedSiteFixture } from "../apps/web/src/server/site-fixture.js";

/**
 * Boots the built backend image against a throwaway seeded database and walks
 * the public SSR routes, the ops CLI and ffmpeg.
 *
 * This exists because the image ships a *pruned* node_modules (see the
 * prod-deps stage in apps/backend/Dockerfile). Astro leaves externals
 * unbundled in dist/server/chunks/*.mjs, so a new bare import in apps/web can
 * silently land on a package the prune removed. Nothing else catches that:
 *   - `bun run build` succeeds, the missing package is present on the runner;
 *   - apps/web/src/server/home.smoke.test.ts drives `astro dev` from the repo,
 *     not the image, so it resolves against the full node_modules;
 *   - the container starts fine and only fails per request, with every SSR
 *     route returning 500 while /healthz and static files still answer 200.
 * Hence: run the real image, and assert on rendered bodies rather than on
 * process liveness.
 *
 *   IMAGE=ghcr.io/... bun scripts/image-smoke.ts
 */

const image = process.env.IMAGE;
if (!image) {
  console.error("IMAGE is required, e.g. IMAGE=ghcr.io/owner/alexgetman-backend@sha256:...");
  process.exit(1);
}

const container = `image-smoke-${process.pid}`;
const volume = `image-smoke-${process.pid}`;
const port = 18000 + (process.pid % 20000);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-smoke-"));
const dataDir = path.join(root, "data");
const publicDir = path.join(dataDir, "site");
fs.mkdirSync(publicDir, { recursive: true });

/** Mirrors the fixture the dev server and the SSR smoke test use, so all three
 * look at one shape of data. Two images on the first post keep the gallery
 * path exercised. */
const { imagePaths } = seedSiteFixture({
  dbPath: path.join(dataDir, "pipeline.db"),
  publicDir,
  posts: devFixture(3, 2),
});

const failures: string[] = [];
const check = (ok: boolean, what: string, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(what);
};

async function run(command: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out + err };
}

async function cleanup(): Promise<void> {
  await run(["docker", "rm", "-f", container]);
  await run(["docker", "volume", "rm", "-f", volume]);
  fs.rmSync(root, { recursive: true, force: true });
}

try {
  /**
   * The fixture goes into a docker volume rather than a bind mount, and the
   * container is created, filled and only then started.
   *
   * A bind mount looks fine on macOS and breaks on Linux. Docker Desktop and
   * OrbStack virtualise bind-mount ownership; a real Linux host does not. The
   * entrypoint chowns /data itself and drops to uid 1000, but
   * fixDataDirectoriesOwnership is deliberately non-recursive (see
   * foundation/runtime/data-dirs.ts), so a seeded pipeline.db keeps the uid of
   * whoever ran this script and the server dies on its first write with
   * SQLITE_READONLY. The mirror image bites on the way out: files the
   * container leaves behind as uid 1000 are not deletable by that same user.
   *
   * Inside a volume the chown is real on every platform, and teardown is
   * `docker volume rm`, so no host uid is ever involved.
   */
  const created = await run([
    "docker",
    "create",
    "--name",
    container,
    "-p",
    `127.0.0.1:${port}:8788`,
    "-v",
    `${volume}:/data`,
    "-v",
    `${path.resolve("studio.yaml")}:/app/studio.yaml:ro`,
    "-e",
    "DATA_DIR=/data",
    "-e",
    "PIPELINE_DB=/data/pipeline.db",
    "-e",
    "SITE_PUBLIC_DIR=/data/site",
    "-e",
    "FEED_JSON=/data/feed.json",
    "-e",
    "SITE_METRICS_JSON=/data/metrics.json",
    "-e",
    "SITE_CONTENT_METRICS_JSON=/data/content-metrics.json",
    "-e",
    "MEDIA_CACHE_DIR=/data/media-cache",
    "-e",
    "VIDEO_MEDIA_DIR=/data/video-media",
    "-e",
    "STUDIO_CONFIG=/app/studio.yaml",
    // No credentials here: the bot and story publishing must stay off, or the
    // smoke run would reach out to Telegram from CI.
    "-e",
    "ENABLE_BOT_POLLING=false",
    "-e",
    "ENABLE_TELEGRAM_STORIES=false",
    "-e",
    "BIND_HOST=0.0.0.0",
    "-e",
    "PORT=8788",
    "-e",
    "CHANNEL_USERNAME=alexgetmancom",
    image,
  ]);
  if (created.code !== 0) throw new Error(`docker create failed: ${created.out}`);

  const copied = await run(["docker", "cp", `${dataDir}/.`, `${container}:/data`]);
  if (copied.code !== 0) throw new Error(`docker cp failed: ${copied.out}`);

  // `docker cp` writes as root; hand the whole tree to the runtime user before
  // the entrypoint drops privileges.
  const owned = await run([
    "docker",
    "run",
    "--rm",
    "--user",
    "0",
    "--entrypoint",
    "chown",
    "-v",
    `${volume}:/data`,
    image,
    "-R",
    "1000:1000",
    "/data",
  ]);
  if (owned.code !== 0) throw new Error(`chown failed: ${owned.out}`);

  const started = await run(["docker", "start", container]);
  if (started.code !== 0) throw new Error(`docker start failed: ${started.out}`);

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/readyz`).catch(() => undefined);
    if (response?.ok) {
      ready = true;
      break;
    }
    await Bun.sleep(500);
  }
  check(ready, "container becomes ready");
  if (!ready) throw new Error("never became ready");

  /** Minimum body size per route. A missing runtime dependency renders as a
   * 500 with an empty body, so both the status and the length matter. */
  const routes: [string, number][] = [
    ["/", 5_000],
    ["/ru/", 5_000],
    ["/1/dev-post-1/", 5_000],
    ["/1/dev-post-1.md", 100],
    ["/feed.xml", 500],
    ["/ru/feed.xml", 500],
    ["/feed-ai.json", 500],
    ["/sitemap.xml", 300],
    ["/robots.txt", 50],
  ];
  const probed = await Promise.all(
    routes.map(async ([route, minimumBytes]) => {
      const response = await fetch(base + route);
      const body = await response.text();
      return { route, minimumBytes, status: response.status, body };
    }),
  );
  for (const { route, minimumBytes, status, body } of probed) {
    check(status === 200 && body.length >= minimumBytes, `GET ${route}`, `${status}, ${body.length}b (min ${minimumBytes})`);
  }
  const home = probed.find((entry) => entry.route === "/")?.body ?? "";

  // The read model must link the vertical composite the media worker produces,
  // and that file must actually be served off the mounted public dir.
  const [firstImage] = imagePaths;
  check(home.includes(firstImage), "home links the fixture image", firstImage);
  const media = await fetch(`${base}/${firstImage}`);
  check(media.status === 200, `GET /${firstImage}`, String(media.status));

  // In parallel: each of these spawns a fresh bun in the container, and this
  // step sits on the critical path between the image build and the deploy.
  const opsCommands = ["doctor", "status", "audit", "capabilities"];
  const opsResults = await Promise.all(
    opsCommands.map((command) => run(["docker", "exec", "-u", "bun", container, "bun", "/app/ops/cli.js", command])),
  );
  for (const [index, result] of opsResults.entries()) {
    check(result.code === 0, `ops ${opsCommands[index]}`, `exit ${result.code}`);
  }

  // Both binaries, and a real encode: a broken static build would still answer
  // -version.
  const ffmpeg = await run([
    "docker",
    "exec",
    "-u",
    "bun",
    container,
    "sh",
    "-c",
    "ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=64x64:rate=5 -t 1 -y /tmp/smoke.mp4 " +
      "&& ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/smoke.mp4",
  ]);
  check(ffmpeg.code === 0 && ffmpeg.out.trim().startsWith("1"), "ffmpeg encode + ffprobe read", ffmpeg.out.trim());

  const logs = await run(["docker", "logs", container]);
  const errors = logs.out.split("\n").filter((line) => line.includes('"level":"error"') || line.includes("Cannot find module"));
  check(errors.length === 0, "no errors in container logs", errors.slice(0, 3).join(" | "));
} catch (error) {
  const logs = await run(["docker", "logs", container]);
  console.error(String(error));
  console.error(logs.out.split("\n").slice(-40).join("\n"));
  failures.push("smoke run threw");
} finally {
  await cleanup();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nimage smoke passed");
