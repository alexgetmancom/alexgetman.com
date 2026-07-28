import fs from "node:fs";
import path from "node:path";
// deploy/media-processor is a separately built Docker image (see its Dockerfile),
// not a workspace package, but it lives in this same repo: import its ffmpeg
// recipe directly rather than keeping a second copy that can drift out of sync.
import { storyFfmpegArgs } from "../../../../deploy/media-processor/story-encode.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { runFfmpeg } from "../foundation/runtime/ffmpeg.js";
import { withTimeout } from "../foundation/runtime/timeout.js";
import { HttpPublishError } from "../publishing/errors.js";
import { mediaTransformKey } from "./media-idempotency.js";
import type { PublishMediaItem } from "./social/payload.js";

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
  const video = type === "video";
  log("info", "story media source resolving", { draftId, locale, kind: video ? "video" : "image" });
  const source = await withTimeout(
    resolveSource(item, draftId, locale, directory, config, fetchImpl),
    30_000,
    "story_source_resolution_timeout",
  );
  log("info", "story media source resolved", { draftId, locale, source });
  const stamp = Date.now();
  const output = path.join(directory, `draft-${draftId}-${locale}-story-standard-${stamp}.${video ? "mp4" : "jpg"}`);
  const telegramOutput = video ? path.join(directory, `draft-${draftId}-${locale}-story-telegram-${stamp}.mp4`) : undefined;
  const args = storyFfmpegArgs(source, output, video ? "video" : "image");
  log("info", "story media transform started", { draftId, locale, provider: config.MEDIA_PROCESSOR_PROVIDER });
  if (config.MEDIA_PROCESSOR_PROVIDER === "remote_http") await transformRemotely(source, output, telegramOutput, video, config, fetchImpl);
  else await withTimeout(runFfmpeg(args, config.FFMPEG_TIMEOUT_SECONDS), storyTransformTimeout(config), "story_transform_timeout");
  await withTimeout(fs.promises.chmod(output, 0o664), 30_000, "story_output_finalize_timeout");
  log("info", "story media transform completed", { draftId, locale, output });
  return [
    {
      ...(item as unknown as PublishMediaItem),
      story_local_path: output,
      storyLocalPath: output,
      ...(telegramOutput && fs.existsSync(telegramOutput)
        ? { telegram_story_local_path: telegramOutput, telegramStoryLocalPath: telegramOutput }
        : {}),
      story_width: 1080,
      story_height: 1920,
    },
  ];
}

/** Media Processing Port. The delivery adapters only receive the finished
 * asset; a configured remote worker owns CPU/memory-heavy ffmpeg work. */
async function transformRemotely(
  source: string,
  output: string,
  telegramOutput: string | undefined,
  video: boolean,
  config: BackendConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!config.MEDIA_PROCESSOR_URL || !config.MEDIA_PROCESSOR_TOKEN)
    throw new Error("media_processor_unavailable: remote_http requires MEDIA_PROCESSOR_URL and MEDIA_PROCESSOR_TOKEN");
  const stat = await fs.promises.stat(source);
  const idempotencyKey = await mediaTransformKey(source, `story-variants-v3:${video ? "video" : "image"}`);
  const controller = new AbortController();
  const timeoutSeconds = storyTransformTimeout(config) / 1000;
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    log("info", "story media remote upload started", { source, bytes: stat.size, timeoutSeconds });
    const response = await withTimeout(
      fetchImpl(`${config.MEDIA_PROCESSOR_URL.replace(/\/$/, "")}/v1/transforms/ffmpeg`, {
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
      }),
      timeoutSeconds * 1000,
      "media_processor_upload_timeout",
    );
    log("info", "story media remote response received", { source, status: response.status });
    if (!response.ok || !response.body) {
      const detail = (await response.text()).slice(0, 800);
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = retryAfterHeader == null ? Number.NaN : Number(retryAfterHeader);
      throw new HttpPublishError(
        `media_processor_failed: ${response.status}${detail ? ` ${detail}` : ""}`,
        response.status,
        detail,
        Number.isFinite(retryAfter) ? retryAfter : null,
      );
    }
    // New workers return a manifest, then both cached variants are fetched
    // over the authenticated tunnel. Older single-output workers remain
    // supported during the manual VM-106 promotion window.
    if (response.headers.get("content-type")?.includes("application/json")) {
      const result = (await response.json()) as {
        job?: string;
        requestId?: string;
        timings?: { uploadMs?: number; queueWaitMs?: number; ffmpegMs?: number; totalMs?: number; cacheHit?: boolean };
        outputs?: Record<string, { bytes?: number }>;
      };
      if (!result.outputs?.standard || (video && (!result.outputs.telegram || !telegramOutput)))
        throw new Error("media_processor_failed: incomplete story variants");
      log("info", "story media remote processing completed", {
        source,
        phase: "media_processor.external",
        providerRequestId: result.requestId ?? result.job,
        ...result.timings,
      });
      await downloadRemoteVariant(config, idempotencyKey, "standard", output, fetchImpl);
      if (video && telegramOutput) await downloadRemoteVariant(config, idempotencyKey, "telegram", telegramOutput, fetchImpl);
      log("info", "story media remote variants written", { output, telegramOutput });
    } else {
      const result = await withTimeout(response.arrayBuffer(), 30_000, "media_processor_result_read_timeout");
      await withTimeout(Bun.write(output, result), 30_000, "media_processor_result_write_timeout");
      log("info", "story media remote legacy result written", { output });
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw new Error(`media_processor_timeout: remote worker exceeded ${timeoutSeconds}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadRemoteVariant(
  config: BackendConfig,
  idempotencyKey: string,
  variant: "standard" | "telegram",
  output: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!config.MEDIA_PROCESSOR_URL || !config.MEDIA_PROCESSOR_TOKEN) throw new Error("media_processor_unavailable");
  const response = await withTimeout(
    fetchImpl(`${config.MEDIA_PROCESSOR_URL.replace(/\/$/, "")}/v1/transforms/ffmpeg/${idempotencyKey}/${variant}`, {
      headers: { authorization: `Bearer ${config.MEDIA_PROCESSOR_TOKEN}` },
    }),
    30_000,
    "media_processor_variant_download_timeout",
  );
  if (!response.ok) throw new Error(`media_processor_variant_failed: ${variant} ${response.status}`);
  await withTimeout(Bun.write(output, await response.arrayBuffer()), 30_000, "media_processor_variant_write_timeout");
  await withTimeout(fs.promises.chmod(output, 0o664), 30_000, "story_output_finalize_timeout");
}

function storyTransformTimeout(config: BackendConfig): number {
  // Leave time for provider publication and durable finalization before the
  // queue-level deadline. The abort also stops the HTTP upload to VM-106.
  return Math.max(10_000, Math.min(config.MEDIA_PROCESSOR_TIMEOUT_SECONDS * 1000, (config.PUBLISH_JOB_TIMEOUT_SECONDS - 30) * 1000));
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
