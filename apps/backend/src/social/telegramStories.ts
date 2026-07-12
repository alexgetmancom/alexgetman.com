import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import type { PublishResult } from "../queue/errors.js";
import { runFfmpeg } from "../runtime/ffmpeg.js";
import { type PublishMediaItem, payloadMedia, payloadText } from "./payload.js";
import { createChannelStoryClient } from "./telegramSession.js";

const URL_RE = /https?:\/\/[^\s<>)]*/g;
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
  // Stories should be a clean visual format: never append or preserve links
  // in their caption. Links remain available on the regular post targets.
  const caption = telegramStoryCaption(payloadText(payload));

  if (!config.ENABLE_TELEGRAM_STORIES) return { ok: false, skipped: true, reason: "telegram_stories_disabled" };
  if (!config.TELEGRAM_CHANNEL_STORIES_API_ID || !config.TELEGRAM_CHANNEL_STORIES_API_HASH || !config.TELEGRAM_CHANNEL_STORIES_SESSION) {
    return { ok: false, skipped: true, reason: "missing_channel_story_credentials" };
  }
  if (!config.TELEGRAM_STORIES_CHANNEL) return { ok: false, skipped: true, reason: "missing_story_channel" };
  return publishChannelStory(media, caption, config);
}

async function publishChannelStory(media: PublishMediaItem, caption: string, config: BackendConfig): Promise<PublishResult> {
  let uploadPath = media.storyLocalPath || media.localPath;
  if (!uploadPath) return { ok: false, skipped: true, reason: "missing_media_path" };
  let cleanupPath: string | null = null;
  const clientInstance = createChannelStoryClient(config);
  await clientInstance.connect();
  // Stories are posted on behalf of the authenticated channel. Load the
  // account once so mtcute has its own peer cached before resolving the
  // target channel and sending media.
  await clientInstance.getMe();
  try {
    const metadata = await probeVideo(uploadPath, media);
    if (media.type === "VIDEO" && fs.statSync(uploadPath).size > STORY_MAX_BYTES) {
      cleanupPath = path.join(os.tmpdir(), `tg_story_${Date.now()}.mp4`);
      const targetBytes = 9.5 * 1024 * 1024;
      const videoBitrate = Math.max(150_000, Math.floor((targetBytes * 8) / Math.max(metadata.duration, 1) - 64_000));
      await runFfmpeg([
        "-y",
        "-i",
        uploadPath,
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        `${Math.floor(videoBitrate / 1000)}k`,
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-movflags",
        "+faststart",
        cleanupPath,
      ]);
      uploadPath = cleanupPath;
    }

    const storyChannel = config.TELEGRAM_STORIES_CHANNEL?.replace(/^@/, "");
    if (!storyChannel) throw new Error("telegram_story_channel_missing");
    const story = await withTimeout(
      clientInstance.sendStory({
        peer: storyChannel,
        // A string is interpreted by mtcute as a Bot API/TDLib file ID, not a
        // filesystem path.  Keep the generated 1080x1920 file explicit so
        // Telegram uploads it verbatim (including its letterbox padding).
        media: telegramStoryUploadMedia(uploadPath, media.type),
        caption,
        period: 86_400,
      }),
      120_000,
      "telegram_channel_story_timeout",
    );
    const storyId = story.id;
    return { ok: true, id: storyId, url: `https://t.me/${storyChannel}/s/${storyId}`, raw: { source: "mtproto_stories.sendStory" } };
  } finally {
    await clientInstance.destroy();
    if (cleanupPath) await fs.promises.rm(cleanupPath, { force: true });
  }
}

export function telegramStoryUploadMedia(filePath: string, type: PublishMediaItem["type"]): { type: "photo" | "video"; file: string } {
  // mtcute treats a bare string as a TDLib/Bot API file ID. The `file:`
  // prefix explicitly selects a local filesystem upload.
  return { type: type === "VIDEO" ? "video" : "photo", file: `file:${filePath}` };
}

export function telegramStoryCaption(text: string): string {
  return text
    .replace(URL_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 2048);
}

async function probeVideo(filePath: string, media: PublishMediaItem): Promise<{ width: number; height: number; duration: number }> {
  const fallback = {
    width: Number(media.width ?? 720),
    height: Number(media.height ?? 1280),
    duration: Math.round(Number(media.duration ?? 10)),
  };
  if (media.type !== "VIDEO") return fallback;
  const child = Bun.spawn(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", filePath], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  clearTimeout(timeout);
  if (exitCode !== 0) return fallback;
  try {
    const streams = (JSON.parse(stdout) as { streams?: Array<Record<string, unknown>> }).streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video") ?? {};
    return {
      width: Number(video.width ?? fallback.width),
      height: Number(video.height ?? fallback.height),
      duration: Math.round(Number(video.duration ?? fallback.duration)),
    };
  } catch {
    return fallback;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
