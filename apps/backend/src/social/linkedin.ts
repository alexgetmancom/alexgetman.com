import fs from "node:fs";
import type { BackendConfig } from "../config.js";
import type { PublishResult } from "../queue/errors.js";
import { HttpPublishError } from "../queue/errors.js";
import { type PublishMediaItem, payloadMedia, payloadText, stripLeadingEmojis } from "./payload.js";

type LinkedInResponse = Record<string, unknown> & { id?: string; value?: Record<string, unknown>; status?: string };

export async function publishToLinkedIn(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  if (!config.LINKEDIN_ACCESS_TOKEN || !config.LINKEDIN_AUTHOR_URN) throw new Error("missing LinkedIn credentials");
  const media = payloadMedia(payload).filter((item) => item.localPath);
  const post: Record<string, unknown> = {
    author: config.LINKEDIN_AUTHOR_URN,
    commentary: stripLeadingEmojis(payloadText(payload)),
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED" },
    lifecycleState: "PUBLISHED",
  };

  const images = media.filter((item) => item.type === "IMAGE");
  const videos = media.filter((item) => item.type === "VIDEO");
  if (images.length >= 2 && videos.length === 0) {
    const urns = await Promise.all(images.slice(0, 20).map((item) => uploadImage(item.localPath!, config, fetchImpl)));
    post.content = { multiImage: { images: urns.map((id) => ({ id, altText: "Post image" })) } };
  } else if (media[0]) {
    const mediaUrn =
      media[0].type === "VIDEO"
        ? await uploadVideo(media[0], config, fetchImpl)
        : await uploadImage(media[0].localPath!, config, fetchImpl);
    post.content = { media: { title: "Post Media", id: mediaUrn } };
  }

  const result = await callLinkedIn(config, "rest/posts", fetchImpl, { method: "POST", body: JSON.stringify(post) });
  return { ok: Boolean(result.id), id: result.id ?? null, raw: result };
}

async function uploadImage(localPath: string, config: BackendConfig, fetchImpl: typeof fetch): Promise<string> {
  const initialized = await callLinkedIn(config, "rest/images?action=initializeUpload", fetchImpl, {
    method: "POST",
    body: JSON.stringify({ initializeUploadRequest: { owner: config.LINKEDIN_AUTHOR_URN } }),
  });
  const value = initialized.value ?? {};
  const instructions = Array.isArray(value.uploadInstructions) ? (value.uploadInstructions as Array<Record<string, unknown>>) : [];
  const uploadUrl = stringValue(value.uploadUrl) || stringValue(instructions[0]?.uploadUrl);
  const imageUrn = stringValue(value.image);
  if (!uploadUrl || !imageUrn) throw new Error(`LinkedIn image initializeUpload incomplete: ${JSON.stringify(value)}`);
  await uploadBinary(uploadUrl, await fs.promises.readFile(localPath), fetchImpl);
  return imageUrn;
}

async function uploadVideo(item: PublishMediaItem, config: BackendConfig, fetchImpl: typeof fetch): Promise<string> {
  const localPath = item.localPath!;
  const initialized = await callLinkedIn(config, "rest/videos?action=initializeUpload", fetchImpl, {
    method: "POST",
    body: JSON.stringify({
      initializeUploadRequest: {
        owner: config.LINKEDIN_AUTHOR_URN,
        fileSizeBytes: fs.statSync(localPath).size,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    }),
  });
  const value = initialized.value ?? {};
  const videoUrn = stringValue(value.video);
  const uploadToken = stringValue(value.uploadToken);
  const instructions = Array.isArray(value.uploadInstructions) ? (value.uploadInstructions as Array<Record<string, unknown>>) : [];
  if (!videoUrn || !uploadToken || instructions.length === 0)
    throw new Error(`LinkedIn video initializeUpload incomplete: ${JSON.stringify(value)}`);

  const file = await fs.promises.open(localPath, "r");
  const uploadedPartIds: string[] = [];
  try {
    for (const instruction of instructions) {
      const firstByte = Number(instruction.firstByte);
      const lastByte = Number(instruction.lastByte);
      const buffer = Buffer.alloc(lastByte - firstByte + 1);
      await file.read(buffer, 0, buffer.length, firstByte);
      uploadedPartIds.push(await uploadBinary(stringValue(instruction.uploadUrl), buffer, fetchImpl, true));
    }
  } finally {
    await file.close();
  }
  await callLinkedIn(config, "rest/videos?action=finalizeUpload", fetchImpl, {
    method: "POST",
    body: JSON.stringify({ finalizeUploadRequest: { video: videoUrn, uploadToken, uploadedPartIds } }),
  });

  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const status = await callLinkedIn(config, `rest/videos/${encodeURIComponent(videoUrn)}`, fetchImpl, { method: "GET" });
    if (status.status === "AVAILABLE") return videoUrn;
    if (status.status === "PROCESSING_FAILED") throw new Error("LinkedIn video processing failed");
    await delay(10_000);
  }
  throw new Error("Timed out waiting for LinkedIn video validation");
}

async function uploadBinary(url: string, bytes: Buffer, fetchImpl: typeof fetch, requireEtag = false): Promise<string> {
  if (!url) throw new Error("LinkedIn upload URL is missing");
  const bodyBytes = Uint8Array.from(bytes).buffer;
  const response = await fetchImpl(url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bodyBytes });
  const body = await response.text();
  if (!response.ok) throw new HttpPublishError(`LinkedIn upload ${response.status}: ${body}`, response.status, body);
  const etag = response.headers.get("etag") ?? "";
  if (requireEtag && !etag) throw new Error("ETag header not found in LinkedIn chunk upload response");
  return etag;
}

async function callLinkedIn(
  config: BackendConfig,
  endpoint: string,
  fetchImpl: typeof fetch,
  init: RequestInit,
): Promise<LinkedInResponse> {
  const response = await fetchImpl(`https://api.linkedin.com/${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.LINKEDIN_ACCESS_TOKEN}`,
      "Linkedin-Version": config.LINKEDIN_API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) throw new HttpPublishError(`LinkedIn API ${response.status}: ${body}`, response.status, body);
  const parsed = body ? (JSON.parse(body) as LinkedInResponse) : {};
  return { ...parsed, ...(parsed.id ? {} : response.headers.get("x-restli-id") ? { id: response.headers.get("x-restli-id")! } : {}) };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
