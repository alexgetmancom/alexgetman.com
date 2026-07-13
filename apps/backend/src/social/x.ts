import crypto from "node:crypto";
import fs from "node:fs";
import OAuth from "oauth-1.0a";
import type { BackendConfig } from "../config.js";
import type { PublishResult } from "../publishing/errors.js";
import { HttpPublishError } from "../publishing/errors.js";
import { guessContentType, payloadMedia, payloadText, stripUrls } from "./payload.js";

const UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";

export async function publishToX(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  assertCredentials(config);
  const mediaIds: string[] = [];
  for (const item of payloadMedia(payload)) {
    if (!item.localPath || !fs.existsSync(item.localPath)) continue;
    mediaIds.push(
      item.type === "VIDEO" ? await uploadVideo(item.localPath, config, fetchImpl) : await uploadImage(item.localPath, config, fetchImpl),
    );
  }
  const body = JSON.stringify({ text: stripUrls(payloadText(payload)), ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) });
  const response = await oauthFetch("https://api.twitter.com/2/tweets", config, fetchImpl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const result = await jsonResponse<{ data?: { id?: string } }>(response, "X tweet create");
  const id = result.data?.id;
  return { ok: Boolean(id), id: id ?? null, url: id ? `https://x.com/i/web/status/${id}` : null, raw: result };
}

async function uploadImage(filePath: string, config: BackendConfig, fetchImpl: typeof fetch): Promise<string> {
  const form = new FormData();
  form.set(
    "media",
    new Blob([await fs.promises.readFile(filePath)], { type: guessContentType(filePath) }),
    filePath.split("/").pop() || "image",
  );
  const response = await oauthFetch(UPLOAD_URL, config, fetchImpl, { method: "POST", body: form });
  const result = await jsonResponse<{ media_id_string?: string }>(response, "X media upload");
  if (!result.media_id_string) throw new Error("X media upload missing media_id_string");
  return result.media_id_string;
}

async function uploadVideo(filePath: string, config: BackendConfig, fetchImpl: typeof fetch): Promise<string> {
  const initParams = new URLSearchParams({
    command: "INIT",
    total_bytes: String(fs.statSync(filePath).size),
    media_type: "video/mp4",
    media_category: "amplify_video",
  });
  const initialized = await jsonResponse<{ media_id_string?: string }>(
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
      form.set("media", new Blob([chunk.subarray(0, bytesRead)], { type: "application/octet-stream" }), `segment-${segmentIndex}`);
      const response = await oauthFetch(UPLOAD_URL, config, fetchImpl, { method: "POST", body: form });
      if (!response.ok) throw await responseError(response, `X media APPEND ${segmentIndex}`);
      position += bytesRead;
      segmentIndex += 1;
    }
  } finally {
    await handle.close();
  }

  const finalizeParams = new URLSearchParams({ command: "FINALIZE", media_id: mediaId });
  const finalized = await jsonResponse<ProcessingResponse>(
    await oauthFetch(UPLOAD_URL, config, fetchImpl, formInit(finalizeParams), finalizeParams),
    "X media FINALIZE",
  );
  await waitForProcessing(mediaId, finalized.processing_info, config, fetchImpl);
  return mediaId;
}

async function waitForProcessing(
  mediaId: string,
  initial: ProcessingInfo | undefined,
  config: BackendConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  let processing = initial;
  const deadline = Date.now() + 600_000;
  while (processing && ["pending", "in_progress"].includes(processing.state ?? "")) {
    if (Date.now() >= deadline) throw new Error("X media processing timeout");
    await delay(Math.max(1, processing.check_after_secs ?? 5) * 1000);
    const query = new URLSearchParams({ command: "STATUS", media_id: mediaId });
    const result = await jsonResponse<ProcessingResponse>(
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
  return fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: authorization } });
}

export function oauthAuthorization(
  method: string,
  rawUrl: string,
  config: BackendConfig,
  formParams?: URLSearchParams,
  nonce = crypto.randomBytes(16).toString("hex"),
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const credentials = xCredentials(config);
  const oauth = new OAuth({
    consumer: { key: credentials.consumerKey, secret: credentials.consumerSecret },
    signature_method: "HMAC-SHA1",
    hash_function: (base, key) => crypto.createHmac("sha1", key).update(base).digest("base64"),
  });
  oauth.getNonce = () => nonce;
  oauth.getTimeStamp = () => timestamp;
  const data = formParams ? Object.fromEntries(formParams.entries()) : undefined;
  const authorization = oauth.authorize(
    { url: rawUrl, method: method.toUpperCase(), ...(data ? { data } : {}) },
    {
      key: credentials.accessToken,
      secret: credentials.accessTokenSecret,
    },
  );
  return oauth.toHeader(authorization).Authorization;
}

async function jsonResponse<T>(response: Response, label: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new HttpPublishError(`${label} ${response.status}: ${body}`, response.status, body);
  return body ? (JSON.parse(body) as T) : ({} as T);
}

async function responseError(response: Response, label: string): Promise<HttpPublishError> {
  const body = await response.text();
  return new HttpPublishError(`${label} ${response.status}: ${body}`, response.status, body);
}

function assertCredentials(config: BackendConfig): void {
  void xCredentials(config);
}

function xCredentials(config: BackendConfig): {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
} {
  if (!config.X_CONSUMER_KEY || !config.X_CONSUMER_SECRET || !config.X_ACCESS_TOKEN || !config.X_ACCESS_TOKEN_SECRET)
    throw new Error("missing X credentials");
  return {
    consumerKey: config.X_CONSUMER_KEY,
    consumerSecret: config.X_CONSUMER_SECRET,
    accessToken: config.X_ACCESS_TOKEN,
    accessTokenSecret: config.X_ACCESS_TOKEN_SECRET,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
