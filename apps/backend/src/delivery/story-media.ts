import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../config.js";
import { runFfmpeg } from "../runtime/ffmpeg.js";
import type { PublishMediaItem } from "./social/payload.js";

// Keep one second of headroom below the 60-second story limit used by the
// supported publishing targets. Do not alter the source frame rate: 60 FPS is
// a valid story format and should be retained when supplied by the author.
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
  await runFfmpeg(
    video
      ? [
          "-y",
          "-i",
          source,
          "-t",
          String(STORY_MAX_DURATION_SECONDS),
          "-vf",
          filter,
          "-map",
          "0:v:0",
          "-map",
          "0:a?",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          output,
        ]
      : ["-y", "-i", source, "-vf", filter, "-frames:v", "1", "-q:v", "2", output],
    config.FFMPEG_TIMEOUT_SECONDS,
  );
  await fs.promises.chmod(output, 0o664);
  return [
    { ...(item as unknown as PublishMediaItem), story_local_path: output, storyLocalPath: output, story_width: 1080, story_height: 1920 },
  ];
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
