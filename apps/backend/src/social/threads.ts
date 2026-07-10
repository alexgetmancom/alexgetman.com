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
      const child = await callThreadsWithRetry(config, "me/threads", {
        media_type: item.type,
        is_carousel_item: true,
        [item.type === "VIDEO" ? "video_url" : "image_url"]: item.vpsUrl,
      }, fetchImpl);
      if (child.id) {
        await waitForThreadsContainer(config, child.id, fetchImpl);
        children.push(child.id);
      }
    }
    const parent = await callThreadsWithRetry(config, "me/threads", { media_type: "CAROUSEL", text: parts[0], children: children.join(",") }, fetchImpl);
    if (parent.id) {
      await waitForThreadsContainer(config, parent.id, fetchImpl);
      firstContainer = parent.id;
    }
  } else if (mediaItems[0]) {
    const item = mediaItems[0];
    const container = await callThreadsWithRetry(config, "me/threads", {
      media_type: item.type,
      text: parts[0],
      [item.type === "VIDEO" ? "video_url" : "image_url"]: item.vpsUrl,
    }, fetchImpl);
    if (container.id) {
      await waitForThreadsContainer(config, container.id, fetchImpl);
      firstContainer = container.id;
    }
  } else {
    const container = await callThreadsWithRetry(config, "me/threads", { media_type: "TEXT", text: parts[0] }, fetchImpl);
    if (container.id) {
      await waitForThreadsContainer(config, container.id, fetchImpl);
      firstContainer = container.id;
    }
  }

  if (!firstContainer) return { ok: false, error: "threads_container_missing" };
  const published = await callThreadsWithRetry(config, "me/threads_publish", { creation_id: firstContainer }, fetchImpl);
  if (published.id) ids.push(published.id);
  let parentId = published.id;
  for (const part of parts.slice(1)) {
    const reply = await callThreadsWithRetry(config, "me/threads", { media_type: "TEXT", text: part, reply_to_id: parentId }, fetchImpl);
    if (!reply.id) continue;
    await waitForThreadsContainer(config, reply.id, fetchImpl);
    const replyPublish = await callThreadsWithRetry(config, "me/threads_publish", { creation_id: reply.id }, fetchImpl);
    if (replyPublish.id) {
      ids.push(replyPublish.id);
      parentId = replyPublish.id;
    }
  }
  const permalink = ids[0] ? (await callThreads(config, ids[0], { fields: "permalink" }, fetchImpl, "GET")).permalink?.replace("threads.net", "threads.com") : null;
  return { ok: ids.length > 0, id: ids[0] ?? null, ids, url: permalink ?? null, urls: permalink ? [permalink] : [], partial: ids.length < parts.length };
}

async function callThreadsWithRetry(config: BackendConfig, endpoint: string, payload: Record<string, unknown>, fetchImpl: typeof fetch, method: "GET" | "POST" = "POST"): Promise<ThreadsResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await callThreads(config, endpoint, payload, fetchImpl, method);
    } catch (error) {
      lastError = error;
      const message = String(error instanceof Error ? error.message : error).toLowerCase();
      if (!message.includes("media") && !message.includes("4279009") && !message.includes("429") && !message.includes("5")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
    }
  }
  throw lastError;
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
