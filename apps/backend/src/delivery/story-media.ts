import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../foundation/config.js";
import { runFfmpeg } from "../foundation/runtime/ffmpeg.js";
import type { PublishMediaItem } from "./social/payload.js";

// Keep one second of headroom below the 60-second story limit used by the
// supported publishing targets. Stories have one shared high-quality master:
// 1080x1920, 50 FPS, HEVC video and AAC 320k audio. Its video rate is capped
// to leave a safe margin below Telegram's 30 MB upload limit.
const STORY_MAX_DURATION_SECONDS = 59;

export async function generateStoryMedia(
  raw: unknown,
  draftId: number,
  locale: "ru" | "en",
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishMediaItem[]> {
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  if (items.length !== 1) throw new Error("Story-safe generation supports one media item");
  const item = items[0] as Record<string, unknown>;
  const type = String(item.type ?? "").toLowerCase();
  if (!["photo", "image", "video"].includes(type)) throw new Error("Story-safe generation supports photo or video media");
  const directory = path.join(config.DATA_DIR, "story-media");
  await fs.promises.mkdir(directory, { recursive: true });
  const source = await resolveSource(item, draftId, locale, directory, config, fetchImpl);
  const video = type === "video";
  const output = path.join(directory, `draft-${draftId}-${locale}-story-${Date.now()}.${video ? "mp4" : "jpg"}`);
  const filter = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black";
  const args = video
    ? [
        "-y",
        "-i",
        source,
        "-t",
        String(STORY_MAX_DURATION_SECONDS),
        "-vf",
        filter,
        "-r",
        "50",
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx265",
        "-preset",
        "medium",
        "-b:v",
        "3150k",
        "-maxrate",
        "3300k",
        "-bufsize",
        "6600k",
        "-g",
        "50",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "320k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-tag:v",
        "hvc1",
        "-movflags",
        "+faststart",
        output,
      ]
    : ["-y", "-i", source, "-vf", filter, "-frames:v", "1", "-q:v", "2", output];
  if (config.MEDIA_PROCESSOR_PROVIDER === "remote_http") await transformRemotely(source, output, video, config);
  else await runFfmpeg(args, config.FFMPEG_TIMEOUT_SECONDS);
  await fs.promises.chmod(output, 0o664);
  return [
    { ...(item as unknown as PublishMediaItem), story_local_path: output, storyLocalPath: output, story_width: 1080, story_height: 1920 },
  ];
}

/** Media Processing Port. The delivery adapters only receive the finished
 * asset; a configured remote worker owns CPU/memory-heavy ffmpeg work. */
async function transformRemotely(source: string, output: string, video: boolean, config: BackendConfig): Promise<void> {
  if (!config.MEDIA_PROCESSOR_URL || !config.MEDIA_PROCESSOR_TOKEN)
    throw new Error("media_processor_unavailable: remote_http requires MEDIA_PROCESSOR_URL and MEDIA_PROCESSOR_TOKEN");
  const stat = await fs.promises.stat(source);
  const idempotencyKey = crypto
    .createHash("sha256")
    .update(`${source}:${stat.size}:${stat.mtimeMs}:${video ? "video" : "image"}`)
    .digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.MEDIA_PROCESSOR_TIMEOUT_SECONDS * 1000);
  try {
    const response = await fetch(`${config.MEDIA_PROCESSOR_URL.replace(/\/$/, "")}/v1/transforms/ffmpeg`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.MEDIA_PROCESSOR_TOKEN}`,
        "content-length": String(stat.size),
        "content-type": video ? "video/mp4" : "image/jpeg",
        "x-studio-transform": "story_vertical",
        "x-studio-media-kind": video ? "video" : "image",
        "x-studio-output-name": path.basename(output),
        "x-studio-idempotency-key": idempotencyKey,
      },
      // Bun streams the Studio asset from disk: PS529 never buffers a 1 GB
      // upload just to pass it to the remote processor.
      body: Bun.file(source),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const detail = (await response.text()).slice(0, 800);
      throw new Error(`media_processor_failed: ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    await Bun.write(output, response);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw new Error(`media_processor_timeout: remote worker exceeded ${config.MEDIA_PROCESSOR_TIMEOUT_SECONDS}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSource(
  item: Record<string, unknown>,
  draftId: number,
  locale: string,
  directory: string,
  config: BackendConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const local = stringValue(item.local_path) || stringValue(item.localPath) || stringValue(item.path);
  if (local && path.isAbsolute(local) && fs.existsSync(local)) return local;
  const fileId = stringValue(item.file_id) || stringValue(item.fileId);
  if (!fileId || !config.controllerBotToken) throw new Error("Cannot resolve story source media");
  const base = config.TELEGRAM_API_BASE_URL.replace(/\/$/, "");
  const response = await fetchImpl(`${base}/bot${config.controllerBotToken}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const info = (await response.json()) as { ok?: boolean; result?: { file_path?: string } };
  const filePath = info.result?.file_path;
  if (!response.ok || !info.ok || !filePath) throw new Error("Telegram getFile failed for story media");
  if (path.isAbsolute(filePath)) return filePath;
  const extension = path.extname(filePath) || (String(item.type ?? "").toLowerCase() === "video" ? ".mp4" : ".jpg");
  const target = path.join(directory, `draft-${draftId}-${locale}-source${extension}`);
  const download = await fetchImpl(`${base}/file/bot${config.controllerBotToken}/${filePath}`);
  if (!download.ok) throw new Error(`Telegram file download failed: ${download.status}`);
  await fs.promises.writeFile(target, Buffer.from(await download.arrayBuffer()));
  return target;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
