import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Api, TelegramClient, client, sessions } from "telegram";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import type { PublishResult } from "../queue/errors.js";
import { HttpPublishError } from "../queue/errors.js";
import { runFfmpeg } from "../runtime/ffmpeg.js";
import { guessContentType, payloadCanonicalUrl, payloadMedia, payloadText, type PublishMediaItem } from "./payload.js";

const URL_RE = /https?:\/\/[^\s<>)]*/;
const STORY_MAX_BYTES = Math.floor(9.8 * 1024 * 1024);

export async function publishTelegramStory(
  payload: Record<string, unknown>,
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  const media = payloadMedia(payload).find((item) => item.storyLocalPath || item.localPath);
  if (!media) return { ok: false, skipped: true, reason: "missing_media" };
  const caption = payloadText(payload).slice(0, 2048);
  const link = caption.match(URL_RE)?.[0] ?? payloadCanonicalUrl(payload, config) ?? config.PUBLIC_BASE_URL;

  if (config.TELEGRAM_CHANNEL_STORIES_API_ID && config.TELEGRAM_CHANNEL_STORIES_API_HASH && config.TELEGRAM_CHANNEL_STORIES_SESSION) {
    return publishChannelStory(media, caption, link, config);
  }
  if (!config.ENABLE_TELEGRAM_STORIES) return { ok: false, skipped: true, reason: "telegram_stories_disabled" };
  const businessConnectionId = config.TELEGRAM_STORIES_BUSINESS_CONNECTION_ID ?? readBusinessConnectionId(backendDb);
  if (!businessConnectionId) return { ok: false, skipped: true, reason: "missing_business_connection_id" };
  if (media.type === "VIDEO") return { ok: false, skipped: true, reason: "telegram_story_video_requires_h265_profile" };
  return publishBusinessStory(media, caption, link, businessConnectionId, config, fetchImpl);
}

async function publishChannelStory(media: PublishMediaItem, caption: string, link: string, config: BackendConfig): Promise<PublishResult> {
  let uploadPath = media.storyLocalPath || media.localPath!;
  let cleanupPath: string | null = null;
  const clientInstance = new TelegramClient(
    new sessions.StringSession(config.TELEGRAM_CHANNEL_STORIES_SESSION),
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

async function publishBusinessStory(
  media: PublishMediaItem,
  caption: string,
  link: string,
  businessConnectionId: string,
  config: BackendConfig,
  fetchImpl: typeof fetch,
): Promise<PublishResult> {
  if (!config.TELEGRAM_STORIES_BOT_TOKEN) throw new Error("missing TELEGRAM_STORIES_BOT_TOKEN");
  const form = new FormData();
  form.set("business_connection_id", businessConnectionId);
  form.set("active_period", "86400");
  form.set("content", JSON.stringify({ type: "photo", photo: "attach://story" }));
  form.set("story", new Blob([await fs.promises.readFile(media.storyLocalPath || media.localPath!)], { type: guessContentType(media.storyLocalPath || media.localPath!) }), path.basename(media.storyLocalPath || media.localPath!));
  if (caption) form.set("caption", caption);
  if (link) form.set("areas", JSON.stringify([{ position: { x_percentage: 50, y_percentage: 85, width_percentage: 80, height_percentage: 12, rotation_angle: 0, corner_radius_percentage: 4 }, type: { type: "link", url: link } }]));
  const response = await fetchImpl(`${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/bot${config.TELEGRAM_STORIES_BOT_TOKEN}/postStory`, { method: "POST", body: form });
  const body = await response.text();
  if (!response.ok) throw new HttpPublishError(`Telegram postStory ${response.status}: ${body}`, response.status, body);
  const result = body ? JSON.parse(body) as { ok?: boolean; result?: { id?: number } } : {};
  return { ok: Boolean(result.ok), id: result.result?.id ?? null, raw: result };
}

function readBusinessConnectionId(backendDb: BackendDb): string | null {
  const row = backendDb.sqlite.prepare("SELECT state_json FROM worker_state WHERE name='telegram_business_connection'").get() as { state_json?: string } | undefined;
  if (!row?.state_json) return null;
  try {
    const state = JSON.parse(row.state_json) as { is_enabled?: boolean; business_connection_id?: string };
    return state.is_enabled === false ? null : state.business_connection_id ?? null;
  } catch {
    return null;
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
