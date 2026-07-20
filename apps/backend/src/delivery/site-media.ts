import fs from "node:fs";
import path from "node:path";
import {
  SITE_MEDIA_DIR_SEGMENTS,
  SITE_MEDIA_URL_PREFIX,
  siteMediaFilename,
  siteMediaPosterFilename,
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

/** Delivery projection: copy publication media into the public site. */
export async function materializeSiteMedia(
  config: BackendConfig,
  postId: number,
  locale: "ru" | "en",
  raw: unknown,
  fetchImpl: typeof fetch = fetch,
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
    const output: Record<string, unknown> = { ...item, type: kind, path: `${SITE_MEDIA_URL_PREFIX}/${filename}` };
    if (kind === "video") {
      const posterName = siteMediaPosterFilename(postId, locale, index);
      const poster = path.join(directory, posterName);
      await runFfmpeg(["-y", "-ss", "0.5", "-i", target, "-frames:v", "1", "-q:v", "2", poster]);
      await fs.promises.chmod(poster, 0o664);
      await materializeResponsiveVariants(config, poster);
      output.poster = `${SITE_MEDIA_URL_PREFIX}/${posterName}`;
    } else {
      await materializeResponsiveVariants(config, target);
    }
    result.push(output);
  }
  return result;
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
    if (await isCurrentCopy(source, output)) continue;
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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
