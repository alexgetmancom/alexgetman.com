import fs from "node:fs";
import type { BackendConfig } from "../config.js";
import type { PublishResult } from "../queue/errors.js";
import { requestJson } from "./http.js";
import { guessContentType, payloadMedia, payloadText, splitText } from "./payload.js";

type Session = {
  did: string;
  accessJwt: string;
};

type BlobResponse = {
  blob?: Record<string, unknown>;
};

type CreateRecordResponse = {
  uri?: string;
  cid?: string;
};

export function blueskyPublicUrl(uri: string | undefined | null, handle: string | undefined | null): string | null {
  if (!uri || !uri.includes("/app.bsky.feed.post/")) return null;
  const postId = uri.split("/").pop();
  const profile = handle || "alexgetmancom.bsky.social";
  return postId ? `https://bsky.app/profile/${profile}/post/${postId}` : null;
}

export async function publishToBluesky(payload: Record<string, unknown>, config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<PublishResult> {
  if (!config.BLUESKY_HANDLE || !config.BLUESKY_APP_PASSWORD) return { skipped: true, reason: "missing Bluesky credentials" };
  const session = await requestJson<Session>(fetchImpl, "https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: config.BLUESKY_HANDLE, password: config.BLUESKY_APP_PASSWORD }),
  });

  const images: Record<string, unknown>[] = [];
  for (const item of payloadMedia(payload)) {
    if (item.type !== "IMAGE" || !item.localPath) continue;
    const bytes = await fs.promises.readFile(item.localPath);
    const uploaded = await requestJson<BlobResponse>(fetchImpl, "https://bsky.social/xrpc/com.atproto.repo.uploadBlob", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessJwt}`,
        "Content-Type": guessContentType(item.localPath),
      },
      body: bytes,
    });
    if (uploaded.blob) images.push({ alt: "", image: uploaded.blob });
    if (images.length >= 4) break;
  }

  const ids: string[] = [];
  const urls: string[] = [];
  let root: { uri: string; cid: string } | null = null;
  let parent: { uri: string; cid: string } | null = null;
  const createdAt = Date.now();
  for (const [index, part] of splitText(payloadText(payload), 300).entries()) {
    const record: Record<string, unknown> = {
      "$type": "app.bsky.feed.post",
      text: part,
      createdAt: new Date(createdAt + index * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
      langs: ["ru", "en"],
    };
    if (index === 0 && images.length > 0) record.embed = { "$type": "app.bsky.embed.images", images };
    if (root && parent) record.reply = { root, parent };
    const created = await requestJson<CreateRecordResponse>(fetchImpl, "https://bsky.social/xrpc/com.atproto.repo.createRecord", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record }),
    });
    if (!created.uri || !created.cid) continue;
    const ref = { uri: created.uri, cid: created.cid };
    if (!root) root = ref;
    parent = ref;
    ids.push(created.uri);
    const url = blueskyPublicUrl(created.uri, config.BLUESKY_HANDLE);
    if (url) urls.push(url);
  }
  return { ok: ids.length > 0, id: ids[0] ?? null, url: urls[0] ?? null, ids, urls };
}
