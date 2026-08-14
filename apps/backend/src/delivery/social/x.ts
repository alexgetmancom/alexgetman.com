import fs from "node:fs";
import type { BackendConfig } from "../../foundation/config.js";
import { externalFetch } from "../../foundation/http.js";
import type { PublishResult } from "../../publishing/errors.js";
import { type HttpPublishError, httpPublishError, publishJson } from "../../publishing/errors.js";
import { formatPlatformText } from "../../publishing/platform-profiles.js";
import { ambiguousExternalMutation } from "../ambiguous-publication.js";
import { guessContentType, payloadMedia, payloadText } from "./payload.js";

const UPLOAD_URL = "https://api.x.com/2/media/upload";
type SleepImplementation = (milliseconds: number) => Promise<void>;
const defaultSleep: SleepImplementation = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function publishToX(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: SleepImplementation = defaultSleep,
): Promise<PublishResult> {
  assertXAccessToken(config);
  const mediaIds: string[] = [];
  for (const item of payloadMedia(payload)) {
    if (!item.localPath || !fs.existsSync(item.localPath)) continue;
    mediaIds.push(
      item.type === "VIDEO"
        ? await uploadMedia(item.localPath, "tweet_video", config, fetchImpl, sleepImpl)
        : await uploadMedia(item.localPath, "tweet_image", config, fetchImpl, sleepImpl),
    );
  }
  const body = JSON.stringify({
    text: formatPlatformText("x", payloadText(payload)),
    ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}),
  });
  const response = await ambiguousExternalMutation("x", () =>
    xFetch("https://api.x.com/2/tweets", config, fetchImpl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );
  const result = await publishJson<{ data?: { id?: string } }>(response, "X tweet create");
  const id = result.data?.id;
  return { ok: Boolean(id), id: id ?? null, url: id ? `https://x.com/i/web/status/${id}` : null, raw: result };
}

export async function verifyXPost(id: string, config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<{ id: string }> {
  const response = await xFetch(`https://api.x.com/2/tweets/${encodeURIComponent(id)}`, config, fetchImpl, { method: "GET" });
  const result = await publishJson<{ data?: { id?: string } }>(response, "X post verify");
  if (result.data?.id !== id) throw new Error("X verification did not return the expected post");
  return { id };
}

async function uploadMedia(
  filePath: string,
  category: "tweet_image" | "tweet_video",
  config: BackendConfig,
  fetchImpl: typeof fetch,
  sleepImpl: SleepImplementation,
): Promise<string> {
  const initialized = await publishJson<{ data?: { id?: string } }>(
    await xFetch(`${UPLOAD_URL}/initialize`, config, fetchImpl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        total_bytes: fs.statSync(filePath).size,
        media_type: guessContentType(filePath),
        media_category: category,
      }),
    }),
    "X media INIT",
  );
  const mediaId = initialized.data?.id;
  if (!mediaId) throw new Error("X media INIT missing data.id");

  const handle = await fs.promises.open(filePath, "r");
  try {
    let position = 0;
    let segmentIndex = 0;
    const chunk = Buffer.alloc(2 * 1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const form = new FormData();
      form.set("segment_index", String(segmentIndex));
      // Copy out of the reusable read buffer: the next iteration overwrites it,
      // and nothing here guarantees the Blob has finished reading by then.
      const segment = Buffer.from(chunk.subarray(0, bytesRead));
      form.set("media", new Blob([segment], { type: "application/octet-stream" }), `segment-${segmentIndex}`);
      const response = await xFetch(`${UPLOAD_URL}/${mediaId}/append`, config, fetchImpl, { method: "POST", body: form });
      if (!response.ok) throw await responseError(response, `X media APPEND ${segmentIndex}`);
      position += bytesRead;
      segmentIndex += 1;
    }
  } finally {
    await handle.close();
  }

  const finalized = await publishJson<ProcessingResponse>(
    await xFetch(`${UPLOAD_URL}/${mediaId}/finalize`, config, fetchImpl, { method: "POST" }),
    "X media FINALIZE",
  );
  await waitForProcessing(mediaId, finalized.data?.processing_info ?? finalized.processing_info, config, fetchImpl, sleepImpl);
  return mediaId;
}

async function waitForProcessing(
  mediaId: string,
  initial: ProcessingInfo | undefined,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  sleepImpl: SleepImplementation,
): Promise<void> {
  let processing = initial;
  const deadline = Date.now() + 600_000;
  while (processing && ["pending", "in_progress"].includes(processing.state ?? "")) {
    if (Date.now() >= deadline) throw new Error("X media processing timeout");
    await sleepImpl(Math.max(1, processing.check_after_secs ?? 5) * 1000);
    const query = new URLSearchParams({ media_id: mediaId });
    const result = await publishJson<ProcessingResponse>(
      await xFetch(`${UPLOAD_URL}?${query}`, config, fetchImpl, { method: "GET" }),
      "X media STATUS",
    );
    processing = result.data?.processing_info ?? result.processing_info;
    if (processing?.state === "failed") throw new Error(`X video processing failed: ${processing.error?.message ?? "Unknown error"}`);
  }
}

type ProcessingInfo = { state?: string; check_after_secs?: number; error?: { message?: string } };
type ProcessingResponse = { data?: { processing_info?: ProcessingInfo }; processing_info?: ProcessingInfo };

async function xFetch(url: string, config: BackendConfig, fetchImpl: typeof fetch, init: RequestInit): Promise<Response> {
  assertXAccessToken(config);
  return externalFetch(fetchImpl, url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${config.X_ACCESS_TOKEN}` } });
}

function assertXAccessToken(config: BackendConfig): void {
  if (!config.X_ACCESS_TOKEN) throw new Error("missing X OAuth access token; connect X in Studio > Channels");
}

async function responseError(response: Response, label: string): Promise<HttpPublishError> {
  return httpPublishError(response, await response.text(), label);
}
