import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BackendConfig } from "../config.js";
import { runFfmpeg } from "../runtime/ffmpeg.js";
import { requestJson } from "../social/http.js";
import { mediaExtension, safeMediaName, type PublishMediaItem } from "../social/payload.js";

type TelegramFileResponse = {
  ok?: boolean;
  result?: {
    file_path?: string;
  };
};

export async function prepareMediaItems(config: BackendConfig, sourceItems: PublishMediaItem[], fetchImpl: typeof fetch = fetch): Promise<{ items: PublishMediaItem[]; cleanup: () => Promise<void> }> {
  const batchId = `${Date.now()}_${randomUUID()}`;
  const tempFiles: string[] = [];
  const stagedFiles: string[] = [];
  const prepared: PublishMediaItem[] = [];
  await fs.promises.mkdir(config.TEMP_MEDIA_DIR, { recursive: true });
  await fs.promises.mkdir(config.REMOTE_MEDIA_PATH, { recursive: true });

  for (let index = 0; index < sourceItems.length; index += 1) {
    const item = sourceItems[index]!;
    const localPath = await ensureLocalMedia(config, item, index, batchId, tempFiles, fetchImpl);
    let uploadPath = localPath;
    if (item.type === "VIDEO") {
      uploadPath = await normalizeVideoForPublicUpload(config, localPath);
      tempFiles.push(uploadPath);
    }
    const remoteFilename = `${batchId}_crosspost_${index}_${safeMediaName(item.fileId || localPath)}${mediaExtension(item)}`;
    const stagedPath = path.join(config.REMOTE_MEDIA_PATH, remoteFilename);
    await fs.promises.copyFile(uploadPath, stagedPath);
    await fs.promises.chmod(stagedPath, 0o644);
    stagedFiles.push(stagedPath);

    const preparedItem: PublishMediaItem = {
      ...item,
      localPath: uploadPath,
      vpsUrl: `${config.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, "")}/${remoteFilename}`,
    };
    if (item.storyLocalPath && item.type === "IMAGE") {
      const storyRemoteFilename = `${Math.floor(Date.now() / 1000)}_crosspost_${index}_${safeMediaName(item.storyLocalPath)}_story.jpg`;
      const storyStagedPath = path.join(config.REMOTE_MEDIA_PATH, storyRemoteFilename);
      await fs.promises.copyFile(item.storyLocalPath, storyStagedPath);
      await fs.promises.chmod(storyStagedPath, 0o644);
      stagedFiles.push(storyStagedPath);
      preparedItem.storyVpsUrl = `${config.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, "")}/${storyRemoteFilename}`;
    }
    prepared.push(preparedItem);
  }

  return {
    items: prepared,
    cleanup: async () => {
      await Promise.allSettled(tempFiles.map((file) => fs.promises.rm(file, { force: true })));
      if (stagedFiles.length > 0) {
        await Promise.allSettled(stagedFiles.map((file) => fs.promises.rm(file, { force: true })));
      }
    },
  };
}

async function ensureLocalMedia(config: BackendConfig, item: PublishMediaItem, index: number, batchId: string, tempFiles: string[], fetchImpl: typeof fetch): Promise<string> {
  if (item.localPath) return item.localPath;
  if (!item.fileId) throw new Error("media item has neither localPath nor fileId");
  const fileUrl = await getTelegramFileUrl(config, item.fileId, item.token, fetchImpl);
  const ext = mediaExtension(item);
  const target = path.join(config.TEMP_MEDIA_DIR, `telegram_${batchId}_${index}_${safeMediaName(item.fileId)}${ext}`);
  if (fileUrl.startsWith("file://")) {
    const source = fileUrl.slice("file://".length);
    await fs.promises.copyFile(source, target);
    tempFiles.push(target);
    return target;
  }
  const response = await fetchImpl(fileUrl);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram file download failed: ${response.status} ${body}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(target, bytes);
  tempFiles.push(target);
  return target;
}

async function getTelegramFileUrl(config: BackendConfig, fileId: string, token: string | undefined, fetchImpl: typeof fetch): Promise<string> {
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
  if (path.isAbsolute(filePath)) return `file://${filePath}`;
  return `${apiBase}/file/bot${botToken}/${filePath}`;
}

async function normalizeVideoForPublicUpload(config: BackendConfig, inputPath: string): Promise<string> {
  const outputPath = path.join(config.TEMP_MEDIA_DIR, `threads_${Math.floor(Date.now() / 1000)}_${path.basename(inputPath, path.extname(inputPath))}.mp4`);
  await runFfmpeg([
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
  ], config.FFMPEG_TIMEOUT_SECONDS);
  return outputPath;
}
