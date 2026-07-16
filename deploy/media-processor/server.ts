import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";

const token = Bun.env.MEDIA_PROCESSOR_TOKEN;
if (!token || token.length < 16) throw new Error("MEDIA_PROCESSOR_TOKEN must contain at least 16 characters");
const maxBytes = Number(Bun.env.MEDIA_PROCESSOR_MAX_BYTES ?? 1_073_741_824);
const timeoutSeconds = Number(Bun.env.MEDIA_PROCESSOR_TIMEOUT_SECONDS ?? 900);
let tail: Promise<void> = Promise.resolve();
let queued = 0;
let active = 0;

function authorized(request: Request): boolean {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function queue<T>(work: () => Promise<T>): Promise<T> {
  queued += 1;
  const run = async () => {
    queued -= 1;
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
    }
  };
  const next = tail.then(run, run);
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function processedAsset(file: string, mediaKind: string, job: string): Response {
  return new Response(Bun.file(file), {
    headers: {
      "content-type": mediaKind === "video" ? "video/mp4" : "image/jpeg",
      "x-media-processor-job": job,
    },
  });
}

async function streamToFile(source: ReadableStream<Uint8Array>, output: string): Promise<void> {
  const sink = Bun.file(output).writer();
  const reader = source.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sink.write(value);
    }
  } finally {
    sink.end();
  }
}

function ffmpegFailure(exitCode: number, stderr: string, timedOut: boolean): string {
  if (timedOut) return `media_processing_timeout: ffmpeg exceeded ${timeoutSeconds}s`;
  if (exitCode === 137) return "media_processing_failed: ffmpeg exit 137: process was killed (likely out of memory)";
  const detail = stderr
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^frame=\s*\d+\s+fps=/.test(line))
    .slice(-4)
    .join(" · ");
  return `media_processing_failed: ffmpeg exit ${exitCode}: ${detail || "no diagnostic output"}`.slice(0, 1200);
}

async function transcode(
  source: ReadableStream<Uint8Array>,
  sourceSize: number,
  mediaKind: string,
  idempotencyKey: string,
): Promise<Response> {
  if (!Number.isFinite(sourceSize) || sourceSize <= 0 || sourceSize > maxBytes) return new Response("invalid_source_size", { status: 413 });
  if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) return new Response("invalid_idempotency_key", { status: 400 });
  const ext = mediaKind === "video" ? ".mp4" : ".jpg";
  const cached = `/work/cache/${idempotencyKey}${ext}`;
  if (existsSync(cached)) return processedAsset(cached, mediaKind, `cached-${idempotencyKey.slice(0, 12)}`);
  const id = crypto.randomUUID();
  const folder = `/work/${id}`;
  const input = `${folder}/source${ext}`;
  // Keep the final media extension so ffmpeg selects the right muxer even
  // while the output is still an atomic temporary file.
  const partial = `${cached}.${id}.part${ext}`;
  await mkdir(folder, { recursive: true });
  await mkdir("/work/cache", { recursive: true });
  // Keep the incoming asset streaming to the VM disk; only ffmpeg owns the
  // media bytes after this point.
  await streamToFile(source, input);
  const filter = "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black";
  const args =
    mediaKind === "video"
      ? [
          "-y",
          "-i",
          input,
          "-t",
          "59",
          "-vf",
          filter,
          "-map",
          "0:v:0",
          "-map",
          "0:a?",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-b:v",
          "1100k",
          "-maxrate",
          "1200k",
          "-bufsize",
          "2400k",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "64k",
          "-movflags",
          "+faststart",
          "-threads",
          "2",
          partial,
        ]
      : ["-y", "-i", input, "-vf", filter, "-frames:v", "1", "-q:v", "2", partial];
  const child = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutSeconds * 1000);
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timer);
  if (exitCode !== 0) {
    return new Response(ffmpegFailure(exitCode, stderr, timedOut), { status: 422 });
  }
  await rename(partial, cached);
  return processedAsset(cached, mediaKind, id);
}

Bun.serve({
  port: 8787,
  hostname: "0.0.0.0",
  async fetch(request) {
    if (request.method === "GET" && new URL(request.url).pathname === "/health")
      return Response.json({ ok: true, queued, active, concurrency: 1 });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/transforms/ffmpeg")
      return new Response("not_found", { status: 404 });
    if (!authorized(request)) return new Response("unauthorized", { status: 401 });
    const source = request.body;
    if (request.headers.get("x-studio-transform") !== "story_vertical" || !source)
      return new Response("invalid_transform_request", { status: 400 });
    const mediaKind =
      request.headers.get("x-studio-media-kind") === "video"
        ? "video"
        : request.headers.get("x-studio-media-kind") === "image"
          ? "image"
          : null;
    if (!mediaKind) return new Response("invalid_media_kind", { status: 400 });
    const sourceSize = Number(request.headers.get("content-length"));
    return queue(() => transcode(source, sourceSize, mediaKind, request.headers.get("x-studio-idempotency-key") ?? ""));
  },
});
