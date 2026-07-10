import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Api, TelegramClient, client, sessions } from "telegram";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import type { PublishResult } from "../queue/errors.js";
import { runFfmpeg } from "../runtime/ffmpeg.js";
import { guessContentType, payloadCanonicalUrl, payloadMedia, payloadText, type PublishMediaItem } from "./payload.js";
import { loadChannelStorySession } from "./telegramSession.js";

const URL_RE = /https?:\/\/[^\s<>)]*/;
const STORY_MAX_BYTES = Math.floor(9.8 * 1024 * 1024);

export async function publishTelegramStory(
  payload: Record<string, unknown>,
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  void backendDb;
  void fetchImpl;
  const media = payloadMedia(payload).find((item) => item.storyLocalPath || item.localPath);
  if (!media) return { ok: false, skipped: true, reason: "missing_media" };
  const caption = payloadText(payload).slice(0, 2048);
  const link = caption.match(URL_RE)?.[0] ?? payloadCanonicalUrl(payload, config) ?? config.PUBLIC_BASE_URL;

  if (!config.ENABLE_TELEGRAM_STORIES) return { ok: false, skipped: true, reason: "telegram_stories_disabled" };
  if (!config.TELEGRAM_CHANNEL_STORIES_API_ID || !config.TELEGRAM_CHANNEL_STORIES_API_HASH || !config.TELEGRAM_CHANNEL_STORIES_SESSION) {
    return { ok: false, skipped: true, reason: "missing_channel_story_credentials" };
  }
  return publishChannelStory(media, caption, link, config, loadChannelStorySession(config.TELEGRAM_CHANNEL_STORIES_SESSION));
}

async function publishChannelStory(media: PublishMediaItem, caption: string, link: string, config: BackendConfig, session: sessions.StringSession): Promise<PublishResult> {
  let uploadPath = media.storyLocalPath || media.localPath!;
  let cleanupPath: string | null = null;
  const clientInstance = new TelegramClient(
    session,
    config.TELEGRAM_CHANNEL_STORIES_API_ID!,
    config.TELEGRAM_CHANNEL_STORIES_API_HASH!,
    { connectionRetries: 5 },
  );
  await clientInstance.connect();
  try {
    const metadata = probeVideo(uploadPath, media);
    if (media.type === "VIDEO" && fs.statSync(uploadPath).size > STORY_MAX_BYTES) {
      cleanupPath = path.join(os.tmpdir(), `tg_story_${Date.now()}.mp4`);
      const targetBytes = 9.5 * 1024 * 1024;
      const videoBitrate = Math.max(150_000, Math.floor((targetBytes * 8) / Math.max(metadata.duration, 1) - 64_000));
      await runFfmpeg([
        "-y", "-i", uploadPath,
        "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-b:v", `${Math.floor(videoBitrate / 1000)}k`,
        "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", cleanupPath,
      ]);
      uploadPath = cleanupPath;
    }

    const stat = fs.statSync(uploadPath);
    const uploaded = await clientInstance.uploadFile({ file: new client.uploads.CustomFile(path.basename(uploadPath), stat.size, uploadPath), workers: 1 });
    const inputMedia = media.type === "VIDEO"
      ? new Api.InputMediaUploadedDocument({
          file: uploaded,
          mimeType: guessContentType(uploadPath),
          attributes: [new Api.DocumentAttributeVideo({ duration: metadata.duration, w: metadata.width, h: metadata.height, supportsStreaming: true, nosound: false })],
        })
      : new Api.InputMediaUploadedPhoto({ file: uploaded });
    const peer = await clientInstance.getInputEntity(config.CHANNEL_USERNAME.replace(/^@/, ""));
    const result = await withTimeout(
      clientInstance.invoke(new Api.stories.SendStory({
        peer,
        media: inputMedia,
        privacyRules: [new Api.InputPrivacyValueAllowAll()],
        ...(link ? { mediaAreas: [new Api.MediaAreaUrl({ coordinates: new Api.MediaAreaCoordinates({ x: 50, y: 86, w: 82, h: 12, rotation: 0, radius: 4 }), url: link })] } : {}),
        ...(caption ? { caption } : {}),
        period: 86_400,
      })),
      120_000,
      "telegram_channel_story_timeout",
    );
    const update = "updates" in result ? result.updates.find((item) => item instanceof Api.UpdateStoryID) : undefined;
    const storyId = update instanceof Api.UpdateStoryID ? update.id : null;
    if (!storyId) throw new Error("telegram_channel_story_missing_story_id");
    const channel = config.CHANNEL_USERNAME.replace(/^@/, "");
    return { ok: true, id: storyId, url: `https://t.me/${channel}/s/${storyId}`, raw: { source: "mtproto_stories.sendStory", link } };
  } finally {
    await clientInstance.disconnect();
    if (cleanupPath) await fs.promises.rm(cleanupPath, { force: true });
  }
}

function probeVideo(filePath: string, media: PublishMediaItem): { width: number; height: number; duration: number } {
  const fallback = { width: Number(media.width ?? 720), height: Number(media.height ?? 1280), duration: Math.round(Number(media.duration ?? 10)) };
  if (media.type !== "VIDEO") return fallback;
  const result = spawnSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", filePath], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) return fallback;
  try {
    const streams = (JSON.parse(result.stdout) as { streams?: Array<Record<string, unknown>> }).streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video") ?? {};
    return { width: Number(video.width ?? fallback.width), height: Number(video.height ?? fallback.height), duration: Math.round(Number(video.duration ?? fallback.duration)) };
  } catch {
    return fallback;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
