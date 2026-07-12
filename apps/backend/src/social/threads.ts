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

export async function publishToThreads(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  if (!config.THREADS_ACCESS_TOKEN) return { skipped: true, reason: "missing THREADS_ACCESS_TOKEN" };
  const parts = splitText(payloadText(payload), 480);
  const mediaItems = payloadMedia(payload).filter((item) => item.vpsUrl);
  const ids = Array.isArray(payload._threadsPublishedIds)
    ? payload._threadsPublishedIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  let firstContainer: string | null = null;

  if (ids.length === 0 && mediaItems.length > 1) {
    const children: string[] = [];
    for (const item of mediaItems) {
      const child = await callThreadsWithRetry(
        config,
        "me/threads",
        {
          media_type: item.type,
          is_carousel_item: true,
          [item.type === "VIDEO" ? "video_url" : "image_url"]: item.vpsUrl,
        },
        fetchImpl,
      );
      if (child.id) {
        await waitForThreadsContainer(config, child.id, fetchImpl);
        children.push(child.id);
      }
    }
    const parent = await callThreadsWithRetry(
      config,
      "me/threads",
      { media_type: "CAROUSEL", text: parts[0], children: children.join(",") },
      fetchImpl,
    );
    if (parent.id) {
      await waitForThreadsContainer(config, parent.id, fetchImpl);
      firstContainer = parent.id;
    }
  } else if (ids.length === 0 && mediaItems[0]) {
    const item = mediaItems[0];
    const container = await callThreadsWithRetry(
      config,
      "me/threads",
      {
        media_type: item.type,
        text: parts[0],
        [item.type === "VIDEO" ? "video_url" : "image_url"]: item.vpsUrl,
      },
      fetchImpl,
    );
    if (container.id) {
      await waitForThreadsContainer(config, container.id, fetchImpl);
      firstContainer = container.id;
    }
  } else if (ids.length === 0) {
    const container = await callThreadsWithRetry(config, "me/threads", { media_type: "TEXT", text: parts[0] }, fetchImpl);
    if (container.id) {
      await waitForThreadsContainer(config, container.id, fetchImpl);
      firstContainer = container.id;
    }
  }

  if (firstContainer) {
    const published = await callThreadsWithRetry(config, "me/threads_publish", { creation_id: firstContainer }, fetchImpl);
    if (!published.id) return { ok: false, error: "threads_publish_missing" };
    ids.push(published.id);
  }
  let parentId = ids.at(-1);
  if (!parentId) return { ok: false, error: "threads_container_missing" };
  for (const part of parts.slice(ids.length)) {
    try {
      const reply = await callThreadsWithRetry(config, "me/threads", { media_type: "TEXT", text: part, reply_to_id: parentId }, fetchImpl);
      if (!reply.id) return { partial: true, ids, error: "threads_reply_container_missing", retryable: true };
      await waitForThreadsContainer(config, reply.id, fetchImpl);
      const replyPublish = await callThreadsWithRetry(config, "me/threads_publish", { creation_id: reply.id }, fetchImpl);
      if (!replyPublish.id) return { partial: true, ids, error: "threads_reply_publish_missing", retryable: true };
      ids.push(replyPublish.id);
      parentId = replyPublish.id;
    } catch (error) {
      return { partial: true, ids, error: String(error instanceof Error ? error.message : error), retryable: true };
    }
  }
  const permalink = ids[0]
    ? (await callThreads(config, ids[0], { fields: "permalink" }, fetchImpl, "GET")).permalink?.replace("threads.net", "threads.com")
    : null;
  return {
    ok: ids.length > 0,
    id: ids[0] ?? null,
    ids,
    url: permalink ?? null,
    urls: permalink ? [permalink] : [],
    partial: ids.length < parts.length,
  };
}

async function callThreadsWithRetry(
  config: BackendConfig,
  endpoint: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
  method: "GET" | "POST" = "POST",
): Promise<ThreadsResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await callThreads(config, endpoint, payload, fetchImpl, method);
    } catch (error) {
      lastError = error;
      if (!isRetryableThreadsError(error)) throw error;
      await Bun.sleep(config.THREADS_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

function isRetryableThreadsError(error: unknown): boolean {
  if (error instanceof Error && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (status === 429 || status >= 500) return true;
  }
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return message.includes("media") || message.includes("4279009") || message.includes("timed out");
}

async function callThreads(
  config: BackendConfig,
  endpoint: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
  method: "GET" | "POST" = "POST",
): Promise<ThreadsResponse> {
  const url = new URL(`https://graph.threads.net/v1.0/${endpoint}`);
  const body = formBody({ ...payload, access_token: config.THREADS_ACCESS_TOKEN });
  if (method === "GET") {
    for (const [key, value] of body.entries()) url.searchParams.append(key, value);
    return requestJson<ThreadsResponse>(fetchImpl, url.toString());
  }
  return requestJson<ThreadsResponse>(fetchImpl, url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function waitForThreadsContainer(config: BackendConfig, id: string, fetchImpl: typeof fetch): Promise<void> {
  const deadline = Date.now() + config.THREADS_CONTAINER_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    const status = await callThreads(config, id, { fields: "status,error_message" }, fetchImpl, "GET");
    if (status.status === "FINISHED") return;
    if (status.status === "ERROR" || status.status === "EXPIRED")
      throw new Error(`Threads container ${id} failed: ${status.error_message ?? status.status}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Threads container ${id} timed out`);
}
