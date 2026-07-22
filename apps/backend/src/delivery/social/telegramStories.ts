import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackendConfig } from "../../foundation/config.js";
import { createChannelStoryClient } from "../../foundation/external/telegram-session.js";
import { runFfmpeg } from "../../foundation/runtime/ffmpeg.js";
import { withTimeout } from "../../foundation/runtime/timeout.js";
import type { PublishResult } from "../../publishing/errors.js";
import { type PublishMediaItem, payloadMedia, payloadText } from "./payload.js";

const URL_RE = /https?:\/\/[^\s<>)]*/g;
// mtcute (like the GramJS client this replaced) switches to its "big file"
// upload path - upload.saveBigFilePart / inputFileBig, no checksum - above
// 10 MiB (@mtcute/core's BIG_FILE_MIN_SIZE). stories.sendStory rejects files
// uploaded that way with MEDIA_FILE_INVALID (400), so every video story must
// stay under that threshold, not Telegram's much larger regular-video limit.
const STORY_MAX_BYTES = Math.floor(9.5 * 1024 * 1024);

export async function publishTelegramStory(payload: Record<string, unknown>, config: BackendConfig): Promise<PublishResult> {
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
  await withTimeout(clientInstance.connect(), 30_000, "telegram_channel_story_connect_timeout");
  // Stories are posted on behalf of the authenticated channel. Load the
  // account once so mtcute has its own peer cached before resolving the
  // target channel and sending media.
  await withTimeout(clientInstance.getMe(), 30_000, "telegram_channel_story_identity_timeout");
  try {
    const metadata = await probeVideo(uploadPath, media);
    if (media.type === "VIDEO" && fs.statSync(uploadPath).size > STORY_MAX_BYTES) {
      cleanupPath = path.join(os.tmpdir(), `tg_story_${Date.now()}.mp4`);
      const targetBytes = 9 * 1024 * 1024;
      const audioBitrate = 64_000;
      const videoBitrate = Math.max(150_000, Math.floor((targetBytes * 8) / Math.max(metadata.duration, 1) - audioBitrate));
      await runFfmpeg([
        "-y",
        "-i",
        uploadPath,
        "-r",
        "50",
        "-c:v",
        "libx264",
        "-b:v",
        `${Math.floor(videoBitrate / 1000)}k`,
        "-maxrate",
        `${Math.floor(videoBitrate / 1000)}k`,
        "-bufsize",
        `${Math.floor((videoBitrate * 2) / 1000)}k`,
        "-g",
        "50",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-tag:v",
        "avc1",
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
        media: telegramStoryUploadMedia(uploadPath, media.type, metadata),
        caption,
        period: 86_400,
      }),
      120_000,
      "telegram_channel_story_timeout",
    );
    const storyId = story.id;
    return { ok: true, id: storyId, url: `https://t.me/${storyChannel}/s/${storyId}`, raw: { source: "mtproto_stories.sendStory" } };
  } finally {
    // MTProto teardown is best-effort. A stalled socket close must not keep a
    // durable publishing job (and therefore the queue loop) locked forever.
    try {
      await withTimeout(clientInstance.destroy(), 5_000, "telegram_channel_story_destroy_timeout");
    } catch {
      // The session is process-local; a later worker run can establish a clean
      // connection. Publishing outcome has already been recorded above.
    }
    if (cleanupPath) await fs.promises.rm(cleanupPath, { force: true });
  }
}

export function telegramStoryUploadMedia(
  filePath: string,
  type: PublishMediaItem["type"],
  metadata: { width: number; height: number; duration: number },
): { type: "photo" | "video"; file: string; width?: number; height?: number; duration?: number; supportsStreaming?: boolean } {
  // mtcute treats a bare string as a TDLib/Bot API file ID. The `file:`
  // prefix explicitly selects a local filesystem upload.
  const file = `file:${filePath}`;
  if (type !== "VIDEO") return { type: "photo", file };
  // Without explicit width/height/duration, mtcute builds documentAttributeVideo
  // with all three at 0. A regular chat video tolerates that, but Telegram's
  // stories.sendStory validates them and rejects the upload with
  // MEDIA_FILE_INVALID - this looked like the HEVC codec bug because both
  // produce the same generic error text.
  return { type: "video", file, width: metadata.width, height: metadata.height, duration: metadata.duration, supportsStreaming: true };
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
