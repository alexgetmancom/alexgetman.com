import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SITE_MEDIA_DIR_SEGMENTS,
  SITE_MEDIA_URL_PREFIX,
  siteMediaFilename,
  siteMediaPosterFilename,
  siteMediaVerticalFilename,
} from "../content/site-media-naming.js";
import type { BackendConfig } from "../foundation/config.js";
import { runFfmpeg } from "../foundation/runtime/ffmpeg.js";

type SiteMedia = Record<string, unknown> & {
  type?: string;
  file_id?: string;
  fileId?: string;
  path?: string;
  local_path?: string;
  localPath?: string;
};

const RESPONSIVE_WIDTHS = [360, 640, 960] as const;
export type SiteMediaMaterializeOptions = { maxUploadKbps?: number };

/** Delivery projection: copy publication media into the public site. */
export async function materializeSiteMedia(
  config: BackendConfig,
  postId: number,
  locale: "ru" | "en",
  raw: unknown,
  fetchImpl: typeof fetch = fetch,
  options: SiteMediaMaterializeOptions = {},
): Promise<Record<string, unknown>[]> {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const directory = path.join(config.SITE_PUBLIC_DIR, ...SITE_MEDIA_DIR_SEGMENTS);
  await fs.promises.mkdir(directory, { recursive: true });
  const result: Record<string, unknown>[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const item = source[index] as SiteMedia;
    const kind = String(item.type ?? "image").toLowerCase() === "video" ? "video" : "image";
    const extension = mediaExtension(item, kind);
    const filename = siteMediaFilename(postId, locale, index, extension);
    const target = path.join(directory, filename);
    await copyOrDownload(config, item, target, fetchImpl);
    await fs.promises.chmod(target, 0o664);
    const verticalName = siteMediaVerticalFilename(postId, locale, index, kind);
    const vertical = path.join(directory, verticalName);
    await materializeVerticalViewerMedia(config, target, vertical, kind, options);
    const output: Record<string, unknown> = {
      ...item,
      type: kind,
      // Public media is intentionally long-lived in browser/CDN caches. A content
      // version keeps a replacement from reusing the previous image URL.
      // The web Story player always receives the pre-composited 9:16 file.
      // `target` remains a durable original beside it, never a browser layer.
      path: versionedPublicPath(`${SITE_MEDIA_URL_PREFIX}/${verticalName}`, vertical),
    };
    if (kind === "video") {
      const posterName = siteMediaPosterFilename(postId, locale, index);
      const poster = path.join(directory, posterName);
      await runFfmpeg(["-y", "-ss", "0.5", "-i", vertical, "-frames:v", "1", "-q:v", "2", poster]);
      await fs.promises.chmod(poster, 0o664);
      await materializeResponsiveVariants(config, poster);
      output.poster = versionedPublicPath(`${SITE_MEDIA_URL_PREFIX}/${posterName}`, poster);
    } else {
      await materializeResponsiveVariants(config, vertical);
    }
    result.push(output);
  }
  return result;
}

async function materializeVerticalViewerMedia(
  config: BackendConfig,
  source: string,
  output: string,
  kind: "image" | "video",
  options: SiteMediaMaterializeOptions,
): Promise<void> {
  if (await isCurrentTransform(source, output)) return;
  if (config.MEDIA_PROCESSOR_PROVIDER !== "remote_http") {
    // Explicit local mode remains usable for self-hosters without VM-106. The
    // production route below owns the blurred composite; this CPU recipe keeps
    // the same 9:16 no-crop contract.
    await runFfmpeg([
      "-y",
      "-i",
      source,
      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
      ...(kind === "video"
        ? ["-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-c:a", "copy"]
        : ["-frames:v", "1", "-q:v", "2"]),
      output,
    ]);
    return;
  }
  if (!config.MEDIA_PROCESSOR_URL || !config.MEDIA_PROCESSOR_TOKEN) throw new Error("site_vertical_media_requires_remote_processor");
  const stat = await fs.promises.stat(source);
  const idempotencyKey = crypto
    .createHash("sha256")
    .update(`site-vertical-v1:${source}:${stat.size}:${stat.mtimeMs}:${kind}`)
    .digest("hex");
  const base = config.MEDIA_PROCESSOR_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/v1/transforms/ffmpeg`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.MEDIA_PROCESSOR_TOKEN}`,
      "content-length": String(stat.size),
      "x-studio-transform": "site_vertical",
      "x-studio-media-kind": kind === "video" ? "video" : "image",
      "x-studio-idempotency-key": idempotencyKey,
    },
    body: options.maxUploadKbps ? throttledFileStream(source, options.maxUploadKbps) : Bun.file(source),
    signal: AbortSignal.timeout(config.MEDIA_PROCESSOR_TIMEOUT_SECONDS * 1000),
  });
  if (!response.ok) throw new Error(`site_vertical_media_failed: ${response.status} ${(await response.text()).slice(0, 800)}`);
  const manifest = (await response.json()) as { outputs?: { standard?: unknown } };
  if (!manifest.outputs?.standard) throw new Error("site_vertical_media_failed: missing standard output");
  const download = await fetch(`${base}/v1/transforms/ffmpeg/${idempotencyKey}/standard`, {
    headers: { authorization: `Bearer ${config.MEDIA_PROCESSOR_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!download.ok) throw new Error(`site_vertical_media_download_failed: ${download.status}`);
  await Bun.write(output, await download.arrayBuffer());
  await fs.promises.chmod(output, 0o664);
}

/** Bulk archive work crosses the VPS ↔ home-VM link. Throttle only that
 * opt-in path so routine post delivery remains fast while a maintenance run
 * cannot starve the home VPN/uplink. */
function throttledFileStream(file: string, maxUploadKbps: number): ReadableStream<Uint8Array> {
  const bytesPerSecond = Math.max(1, Math.floor(maxUploadKbps * 1024));
  const reader = Bun.file(file).stream().getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
      await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil((value.byteLength / bytesPerSecond) * 1000)));
    },
    cancel: () => reader.cancel(),
  });
}

function versionedPublicPath(publicPath: string, filePath: string): string {
  const content = fs.readFileSync(filePath);
  return `${publicPath}?v=${crypto.createHash("sha256").update(content).digest("hex").slice(0, 12)}`;
}

/** Create the variants before a post is exposed in the public feed. The web
 * route must only serve these files: spawning ffmpeg while handling visitors
 * previously let a cache-miss burst exhaust the small production container. */
async function materializeResponsiveVariants(config: BackendConfig, source: string): Promise<void> {
  if (!/\.(png|jpe?g)$/i.test(source)) return;
  const relative = path.relative(config.SITE_PUBLIC_DIR, source).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("site media source escapes public directory");
  const basename = relative.replace(/[\\/]/g, "-").replace(/\.[a-z0-9]+$/i, "");
  const outputDir = path.join(config.SITE_PUBLIC_DIR, "generated", "responsive");
  await fs.promises.mkdir(outputDir, { recursive: true });

  for (const width of RESPONSIVE_WIDTHS) {
    const output = path.join(outputDir, `${basename}-${width}.webp`);
    // A WebP derivative is intentionally a different size from its JPG/PNG
    // source. Comparing sizes here made every site build regenerate every
    // responsive image in the archive and blocked newly published posts behind
    // that needless work. For a derivative, source mtime is the freshness key.
    if (await isCurrentDerivative(source, output)) continue;
    const temporary = `${output}.tmp-${process.pid}-${Date.now()}.webp`;
    try {
      await runFfmpeg(["-y", "-i", source, "-vf", `scale='min(${width},iw)':-2`, "-c:v", "libwebp", "-quality", "80", temporary]);
      await fs.promises.chmod(temporary, 0o664);
      await fs.promises.rename(temporary, output);
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

function mediaExtension(item: SiteMedia, kind: "image" | "video"): string {
  if (kind === "video") return "mp4";
  const source = stringValue(item.local_path) || stringValue(item.localPath) || stringValue(item.path);
  const extension = path.extname(source).slice(1).toLowerCase();
  if (["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(extension)) return extension === "jpeg" ? "jpg" : extension;
  return "jpg";
}

async function copyOrDownload(config: BackendConfig, item: SiteMedia, target: string, fetchImpl: typeof fetch): Promise<void> {
  const local = stringValue(item.local_path) || stringValue(item.localPath);
  if (local && fs.existsSync(local)) {
    if (await isCurrentCopy(local, target)) return;
    await fs.promises.copyFile(local, target);
    return;
  }
  const existingPath = stringValue(item.path);
  if (existingPath) {
    const absolute = path.isAbsolute(existingPath) ? existingPath : path.join(config.SITE_PUBLIC_DIR, existingPath.replace(/^\/+/, ""));
    if (fs.existsSync(absolute)) {
      if (await isCurrentCopy(absolute, target)) return;
      await fs.promises.copyFile(absolute, target);
      return;
    }
  }
  const fileId = stringValue(item.file_id) || stringValue(item.fileId);
  if (!fileId) throw new Error("site media has no file_id or local path");
  const token = config.controllerBotToken;
  if (!token) throw new Error("missing Telegram token for site media");
  const base = config.TELEGRAM_API_BASE_URL.replace(/\/$/, "");
  const infoResponse = await fetchImpl(`${base}/bot${token}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const info = (await infoResponse.json()) as { ok?: boolean; result?: { file_path?: string } };
  if (!infoResponse.ok || !info.ok || !info.result?.file_path) throw new Error(`Telegram getFile failed for ${fileId}`);
  const filePath = info.result.file_path;
  if (path.isAbsolute(filePath)) {
    await fs.promises.copyFile(filePath, target);
    return;
  }
  const response = await fetchImpl(`${base}/file/bot${token}/${filePath}`);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  await fs.promises.writeFile(target, Buffer.from(await response.arrayBuffer()));
}

async function isCurrentCopy(source: string, target: string): Promise<boolean> {
  if (path.resolve(source) === path.resolve(target)) return true;
  try {
    const [sourceStat, targetStat] = await Promise.all([fs.promises.stat(source), fs.promises.stat(target)]);
    return sourceStat.size === targetStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs;
  } catch {
    return false;
  }
}

async function isCurrentDerivative(source: string, target: string): Promise<boolean> {
  try {
    const [sourceStat, targetStat] = await Promise.all([fs.promises.stat(source), fs.promises.stat(target)]);
    return targetStat.mtimeMs >= sourceStat.mtimeMs;
  } catch {
    return false;
  }
}

async function isCurrentTransform(source: string, target: string): Promise<boolean> {
  try {
    const [sourceStat, targetStat] = await Promise.all([fs.promises.stat(source), fs.promises.stat(target)]);
    return targetStat.mtimeMs >= sourceStat.mtimeMs;
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
