import type { BackendConfig } from "../config.js";
import type { PublishResult } from "../queue/errors.js";
import { formBody, requestJson } from "./http.js";
import { payloadMedia, payloadText, splitText } from "./payload.js";

type ThreadsResponse = {
  id?: string;
  permalink?: string;
  status?: string;
  error_message?: string;
};

export async function publishToThreads(payload: Record<string, unknown>, config: BackendConfig, fetchImpl: typeof fetch = fetch): Promise<PublishResult> {
  if (!config.THREADS_ACCESS_TOKEN) return { skipped: true, reason: "missing THREADS_ACCESS_TOKEN" };
  const parts = splitText(payloadText(payload), 480);
  const mediaItems = payloadMedia(payload).filter((item) => item.vpsUrl);
  const ids: string[] = [];
  let firstContainer: string | null = null;

  if (mediaItems.length > 1) {
    const children: string[] = [];
    for (const item of mediaItems) {
      const child = await callThreads(config, "me/threads", {
        media_type: item.type,
        is_carousel_item: true,
        [item.type === "VIDEO" ? "video_url" : "image_url"]: item.vpsUrl,
      }, fetchImpl);
      if (child.id) {
        await waitForThreadsContainer(config, child.id, fetchImpl);
        children.push(child.id);
      }
    }
    const parent = await callThreads(config, "me/threads", { media_type: "CAROUSEL", text: parts[0], children: children.join(",") }, fetchImpl);
    if (parent.id) {
      await waitForThreadsContainer(config, parent.id, fetchImpl);
      firstContainer = parent.id;
    }
  } else if (mediaItems[0]) {
    const item = mediaItems[0];
    const container = await callThreads(config, "me/threads", {
      media_type: item.type,
      text: parts[0],
      [item.type === "VIDEO" ? "video_url" : "image_url"]: item.vpsUrl,
    }, fetchImpl);
    if (container.id) {
      await waitForThreadsContainer(config, container.id, fetchImpl);
      firstContainer = container.id;
    }
  } else {
    const container = await callThreads(config, "me/threads", { media_type: "TEXT", text: parts[0] }, fetchImpl);
    if (container.id) {
      await waitForThreadsContainer(config, container.id, fetchImpl);
      firstContainer = container.id;
    }
  }

  if (!firstContainer) return { ok: false, error: "threads_container_missing" };
  const published = await callThreads(config, "me/threads_publish", { creation_id: firstContainer }, fetchImpl);
  if (published.id) ids.push(published.id);
  let parentId = published.id;
  for (const part of parts.slice(1)) {
    const reply = await callThreads(config, "me/threads", { media_type: "TEXT", text: part, reply_to_id: parentId }, fetchImpl);
    if (!reply.id) continue;
    await waitForThreadsContainer(config, reply.id, fetchImpl);
    const replyPublish = await callThreads(config, "me/threads_publish", { creation_id: reply.id }, fetchImpl);
    if (replyPublish.id) {
      ids.push(replyPublish.id);
      parentId = replyPublish.id;
    }
  }
  const permalink = ids[0] ? (await callThreads(config, ids[0], { fields: "permalink" }, fetchImpl, "GET")).permalink?.replace("threads.net", "threads.com") : null;
  return { ok: ids.length > 0, id: ids[0] ?? null, ids, url: permalink ?? null, urls: permalink ? [permalink] : [] };
}

async function callThreads(config: BackendConfig, endpoint: string, payload: Record<string, unknown>, fetchImpl: typeof fetch, method: "GET" | "POST" = "POST"): Promise<ThreadsResponse> {
  const url = new URL(`https://graph.threads.net/v1.0/${endpoint}`);
  const body = formBody({ ...payload, access_token: config.THREADS_ACCESS_TOKEN });
  if (method === "GET") {
    for (const [key, value] of body.entries()) url.searchParams.append(key, value);
    return requestJson<ThreadsResponse>(fetchImpl, url.toString());
  }
  return requestJson<ThreadsResponse>(fetchImpl, url.toString(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
}

async function waitForThreadsContainer(config: BackendConfig, id: string, fetchImpl: typeof fetch): Promise<void> {
  const deadline = Date.now() + config.THREADS_CONTAINER_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    const status = await callThreads(config, id, { fields: "status,error_message" }, fetchImpl, "GET");
    if (status.status === "FINISHED") return;
    if (status.status === "ERROR" || status.status === "EXPIRED") throw new Error(`Threads container ${id} failed: ${status.error_message ?? status.status}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Threads container ${id} timed out`);
}
