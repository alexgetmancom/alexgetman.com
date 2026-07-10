import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../config.js";
import { runFfmpeg } from "../runtime/ffmpeg.js";

type SiteMedia = Record<string, unknown> & { type?: string; file_id?: string; fileId?: string; path?: string; local_path?: string; localPath?: string };

export async function materializeSiteMedia(
  config: BackendConfig,
  postId: number,
  locale: "ru" | "en",
  raw: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>[]> {
  const source = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const directory = path.join(config.SITE_PUBLIC_DIR, "media", "posts");
  await fs.promises.mkdir(directory, { recursive: true });
  const result: Record<string, unknown>[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const item = source[index] as SiteMedia;
    const kind = String(item.type ?? "image").toLowerCase() === "video" ? "video" : "image";
    const extension = kind === "video" ? "mp4" : "jpg";
    const filename = `${postId}-${locale}-${index}.${extension}`;
    const target = path.join(directory, filename);
    if (!fs.existsSync(target)) await copyOrDownload(config, item, target, fetchImpl);
    await fs.promises.chmod(target, 0o664);
    const output: Record<string, unknown> = { ...item, type: kind, path: `media/posts/${filename}` };
    if (kind === "video") {
      const posterName = `${postId}-${locale}-${index}-poster.jpg`;
      const poster = path.join(directory, posterName);
      if (!fs.existsSync(poster)) await runFfmpeg(["-y", "-ss", "0.5", "-i", target, "-frames:v", "1", "-q:v", "2", poster]);
      await fs.promises.chmod(poster, 0o664);
      output.poster = `media/posts/${posterName}`;
    }
    result.push(output);
  }
  return result;
}

async function copyOrDownload(config: BackendConfig, item: SiteMedia, target: string, fetchImpl: typeof fetch): Promise<void> {
  const local = stringValue(item.local_path) || stringValue(item.localPath);
  if (local && fs.existsSync(local)) {
    await fs.promises.copyFile(local, target);
    return;
  }
  const existingPath = stringValue(item.path);
  if (existingPath) {
    const absolute = path.isAbsolute(existingPath) ? existingPath : path.join(config.SITE_PUBLIC_DIR, existingPath.replace(/^\/+/, ""));
    if (fs.existsSync(absolute)) {
      await fs.promises.copyFile(absolute, target);
      return;
    }
  }
  const fileId = stringValue(item.file_id) || stringValue(item.fileId);
  if (!fileId) throw new Error("site media has no file_id or local path");
  const token = config.controllerBotToken;
  if (!token) throw new Error("missing Telegram token for site media");
  const base = config.TELEGRAM_API_BASE_URL.replace(/\/$/, "");
  const infoResponse = await fetchImpl(`${base}/bot${token}/getFile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_id: fileId }) });
  const info = await infoResponse.json() as { ok?: boolean; result?: { file_path?: string } };
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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
