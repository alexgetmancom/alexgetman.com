import fs from "node:fs";
import type { BackendConfig } from "../../foundation/config.js";
import { assertXCredentials, oauthAuthorization } from "../../foundation/external/x-oauth.js";
import { externalFetch } from "../../foundation/http.js";
import type { PublishResult } from "../../publishing/errors.js";
import { type HttpPublishError, httpPublishError, publishJson } from "../../publishing/errors.js";
import { formatPlatformText } from "../../publishing/platform-profiles.js";
import { ambiguousExternalMutation } from "../ambiguous-publication.js";
import { guessContentType, payloadMedia, payloadText } from "./payload.js";

const UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";
type SleepImplementation = (milliseconds: number) => Promise<void>;
const defaultSleep: SleepImplementation = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function publishToX(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: SleepImplementation = defaultSleep,
): Promise<PublishResult> {
  assertXCredentials(config);
  const mediaIds: string[] = [];
  for (const item of payloadMedia(payload)) {
    if (!item.localPath || !fs.existsSync(item.localPath)) continue;
    mediaIds.push(
      item.type === "VIDEO"
        ? await uploadVideo(item.localPath, config, fetchImpl, sleepImpl)
        : await uploadImage(item.localPath, config, fetchImpl),
    );
  }
  const body = JSON.stringify({
    text: formatPlatformText("x", payloadText(payload)),
    ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}),
  });
  const response = await ambiguousExternalMutation("x", () =>
    oauthFetch("https://api.twitter.com/2/tweets", config, fetchImpl, {
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
  const response = await oauthFetch(`https://api.twitter.com/2/tweets/${encodeURIComponent(id)}`, config, fetchImpl, { method: "GET" });
  const result = await publishJson<{ data?: { id?: string } }>(response, "X post verify");
  if (result.data?.id !== id) throw new Error("X verification did not return the expected post");
  return { id };
}

async function uploadImage(filePath: string, config: BackendConfig, fetchImpl: typeof fetch): Promise<string> {
  const form = new FormData();
  form.set("media", Bun.file(filePath, { type: guessContentType(filePath) }), filePath.split("/").pop() || "image");
  const response = await oauthFetch(UPLOAD_URL, config, fetchImpl, { method: "POST", body: form });
  const result = await publishJson<{ media_id_string?: string }>(response, "X media upload");
  if (!result.media_id_string) throw new Error("X media upload missing media_id_string");
  return result.media_id_string;
}

async function uploadVideo(
  filePath: string,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  sleepImpl: SleepImplementation,
): Promise<string> {
  const initParams = new URLSearchParams({
    command: "INIT",
    total_bytes: String(fs.statSync(filePath).size),
    media_type: "video/mp4",
    media_category: "amplify_video",
  });
  const initialized = await publishJson<{ media_id_string?: string }>(
    await oauthFetch(UPLOAD_URL, config, fetchImpl, formInit(initParams), initParams),
    "X media INIT",
  );
  const mediaId = initialized.media_id_string;
  if (!mediaId) throw new Error("X media INIT missing media_id_string");

  const handle = await fs.promises.open(filePath, "r");
  try {
    let position = 0;
    let segmentIndex = 0;
    const chunk = Buffer.alloc(2 * 1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const form = new FormData();
      form.set("command", "APPEND");
      form.set("media_id", mediaId);
      form.set("segment_index", String(segmentIndex));
      // Copy out of the reusable read buffer: the next iteration overwrites it,
      // and nothing here guarantees the Blob has finished reading by then.
      const segment = Buffer.from(chunk.subarray(0, bytesRead));
      form.set("media", new Blob([segment], { type: "application/octet-stream" }), `segment-${segmentIndex}`);
      const response = await oauthFetch(UPLOAD_URL, config, fetchImpl, { method: "POST", body: form });
      if (!response.ok) throw await responseError(response, `X media APPEND ${segmentIndex}`);
      position += bytesRead;
      segmentIndex += 1;
    }
  } finally {
    await handle.close();
  }

  const finalizeParams = new URLSearchParams({ command: "FINALIZE", media_id: mediaId });
  const finalized = await publishJson<ProcessingResponse>(
    await oauthFetch(UPLOAD_URL, config, fetchImpl, formInit(finalizeParams), finalizeParams),
    "X media FINALIZE",
  );
  await waitForProcessing(mediaId, finalized.processing_info, config, fetchImpl, sleepImpl);
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
    const query = new URLSearchParams({ command: "STATUS", media_id: mediaId });
    const result = await publishJson<ProcessingResponse>(
      await oauthFetch(`${UPLOAD_URL}?${query}`, config, fetchImpl, { method: "GET" }),
      "X media STATUS",
    );
    processing = result.processing_info;
    if (processing?.state === "failed") throw new Error(`X video processing failed: ${processing.error?.message ?? "Unknown error"}`);
  }
}

type ProcessingInfo = { state?: string; check_after_secs?: number; error?: { message?: string } };
type ProcessingResponse = { processing_info?: ProcessingInfo };

function formInit(params: URLSearchParams): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params };
}

async function oauthFetch(
  url: string,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  init: RequestInit,
  formParams?: URLSearchParams,
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const authorization = oauthAuthorization(method, url, config, formParams);
  return externalFetch(fetchImpl, url, { ...init, headers: { ...init.headers, Authorization: authorization } });
}

async function responseError(response: Response, label: string): Promise<HttpPublishError> {
  return httpPublishError(response, await response.text(), label);
}
