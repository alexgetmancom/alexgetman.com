import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../config.js";
import { runFfmpeg } from "../runtime/ffmpeg.js";
import { requestJson } from "../social/http.js";
import { mediaExtension, type PublishMediaItem } from "../social/payload.js";

type TelegramFileResponse = {
  ok?: boolean;
  result?: {
    file_path?: string;
  };
};

export async function prepareMediaItems(
  config: BackendConfig,
  sourceItems: PublishMediaItem[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ items: PublishMediaItem[]; cleanup: () => Promise<void> }> {
  const tempFiles: string[] = [];
  const prepared: PublishMediaItem[] = [];
  await fs.promises.mkdir(config.MEDIA_CACHE_DIR, { recursive: true });
  await fs.promises.mkdir(config.REMOTE_MEDIA_PATH, { recursive: true });

  for (let index = 0; index < sourceItems.length; index += 1) {
    const item = sourceItems[index]!;
    const cacheKey = await mediaCacheKey(item, index);
    const localPath = await ensureLocalMedia(config, item, cacheKey, fetchImpl);
    let uploadPath = localPath;
    if (item.type === "VIDEO") {
      uploadPath = await normalizeVideoForPublicUpload(config, localPath, cacheKey);
    }
    const remoteFilename = `cache-${cacheKey}${path.extname(uploadPath) || mediaExtension(item)}`;
    const stagedPath = path.join(config.REMOTE_MEDIA_PATH, remoteFilename);
    await copyIfMissing(uploadPath, stagedPath);

    const preparedItem: PublishMediaItem = {
      ...item,
      localPath: uploadPath,
      vpsUrl: `${config.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, "")}/${remoteFilename}`,
    };
    if (item.storyLocalPath) {
      const storyRemoteFilename = `cache-${cacheKey}-story${path.extname(item.storyLocalPath) || mediaExtension(item)}`;
      const storyStagedPath = path.join(config.REMOTE_MEDIA_PATH, storyRemoteFilename);
      await copyIfMissing(item.storyLocalPath, storyStagedPath);
      preparedItem.storyVpsUrl = `${config.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, "")}/${storyRemoteFilename}`;
    }
    prepared.push(preparedItem);
  }

  return {
    items: prepared,
    cleanup: async () => {
      await Promise.allSettled(tempFiles.map((file) => fs.promises.rm(file, { force: true })));
    },
  };
}

export async function pruneMediaCache(config: BackendConfig, now = Date.now()): Promise<number> {
  const cutoff = now - config.MEDIA_CACHE_TTL_SECONDS * 1000;
  const roots = [config.MEDIA_CACHE_DIR, config.REMOTE_MEDIA_PATH];
  let removed = 0;
  for (const root of roots) {
    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || (root === config.REMOTE_MEDIA_PATH && !entry.name.startsWith("cache-"))) return;
        const target = path.join(root, entry.name);
        const stat = await fs.promises.stat(target).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) {
          await fs.promises.rm(target, { force: true });
          removed += 1;
        }
      }),
    );
  }
  return removed;
}

async function ensureLocalMedia(config: BackendConfig, item: PublishMediaItem, cacheKey: string, fetchImpl: typeof fetch): Promise<string> {
  const extension = mediaExtension(item);
  const target = path.join(config.MEDIA_CACHE_DIR, `${cacheKey}${extension}`);
  if (await Bun.file(target).exists()) return target;
  if (item.localPath) {
    await copyIfMissing(item.localPath, target);
    return target;
  }
  if (!item.fileId) throw new Error("media item has neither localPath nor fileId");
  const fileUrl = await getTelegramFileUrl(config, item.fileId, item.token, fetchImpl);
  if (fileUrl.startsWith("file://")) {
    const source = fileUrl.slice("file://".length);
    await copyIfMissing(source, target);
    return target;
  }
  const response = await fetchImpl(fileUrl);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram file download failed: ${response.status} ${body}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await Bun.write(target, bytes);
  return target;
}

async function getTelegramFileUrl(
  config: BackendConfig,
  fileId: string,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<string> {
  const botToken = token || config.controllerBotToken;
  if (!botToken) throw new Error("missing Telegram bot token for media download");
  const apiBase = config.TELEGRAM_API_BASE_URL.replace(/\/$/, "");
  const info = await requestJson<TelegramFileResponse>(fetchImpl, `${apiBase}/bot${botToken}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const filePath = info.result?.file_path;
  if (!info.ok || !filePath) throw new Error(`Telegram getFile failed for ${fileId}`);
  return `${apiBase}/file/bot${botToken}/${filePath}`;
}

async function normalizeVideoForPublicUpload(config: BackendConfig, inputPath: string, cacheKey: string): Promise<string> {
  const outputPath = path.join(config.MEDIA_CACHE_DIR, `${cacheKey}.normalized.mp4`);
  if (await Bun.file(outputPath).exists()) return outputPath;
  await runFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    config.FFMPEG_TIMEOUT_SECONDS,
  );
  return outputPath;
}

async function mediaCacheKey(item: PublishMediaItem, index: number): Promise<string> {
  const localStat = item.localPath ? await fs.promises.stat(item.localPath).catch(() => null) : null;
  const identity = JSON.stringify({
    index,
    type: item.type,
    fileId: item.fileId ?? null,
    localPath: item.localPath ?? null,
    size: localStat?.size ?? null,
    modified: localStat?.mtimeMs ?? null,
  });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

async function copyIfMissing(source: string, target: string): Promise<void> {
  if (await Bun.file(target).exists()) return;
  await fs.promises.copyFile(source, target);
  await fs.promises.chmod(target, 0o644);
}
