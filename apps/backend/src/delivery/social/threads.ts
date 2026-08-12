import type { BackendConfig } from "../../foundation/config.js";
import { type ThreadsTarget, threadsCredentials } from "../../foundation/external/threads.js";
import { formBody, requestJson } from "../../foundation/http.js";
import type { PublishResult } from "../../publishing/errors.js";
import { threadsBody, threadsTextLimit } from "../../publishing/threads-text.js";
import { ambiguousExternalMutation } from "../ambiguous-publication.js";
import { payloadMedia, payloadText, splitText } from "./payload.js";

type ThreadsResponse = {
  id?: string;
  permalink?: string;
  status?: string;
  error_message?: string;
};
type SleepImplementation = (milliseconds: number) => Promise<void>;
type NowImplementation = () => number;
type ThreadsRuntime = { accessToken: string; retryDelayMs: number; containerTimeoutSeconds: number };
const defaultSleep: SleepImplementation = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function publishToThreads(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
  target: ThreadsTarget = "threads_ru",
  sleepImpl: SleepImplementation = defaultSleep,
  nowImpl: NowImplementation = Date.now,
): Promise<PublishResult> {
  const runtime = threadsRuntime(config, target);
  if (!runtime) return { skipped: true, reason: `missing ${threadsCredentials(config, target).envName}` };
  // One post by default: the text is written to fit 500 characters and preflight
  // refuses the draft otherwise, so there is nothing to continue into. A chain is
  // only built when the author waived the rule for this draft and saw the cost.
  const chainApproved = payload.threadsChainApproved === true;
  const entities = Array.isArray(payload.entities) ? (payload.entities as Record<string, unknown>[]) : [];
  const text = threadsBody(target, payloadText(payload), entities, { chain: chainApproved }).text;
  const limit = threadsTextLimit(target);
  if (text.length > limit && !chainApproved) return { ok: false, error: `threads_text_too_long:${text.length}/${limit}` };
  const parts = chainApproved ? splitText(text, limit) : [text];
  const mediaItems = payloadMedia(payload).filter((item) => item.vpsUrl);
  const ids = Array.isArray(payload._threadsPublishedIds)
    ? payload._threadsPublishedIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  let firstContainer: string | null = null;

  if (ids.length === 0 && mediaItems.length > 1) {
    // Threads can report a child as FINISHED, then reject it while the carousel
    // parent is being assembled (error 4279004). Those child IDs cannot be
    // repaired, so build a fresh set once instead of failing the whole target.
    for (let carouselAttempt = 0; carouselAttempt < 2 && !firstContainer; carouselAttempt += 1) {
      try {
        const children: string[] = [];
        for (const item of mediaItems) {
          const child = await callThreadsWithRetry(
            runtime,
            "me/threads",
            {
              media_type: item.type,
              is_carousel_item: true,
              [item.type === "VIDEO" ? "video_url" : "image_url"]: item.vpsUrl,
            },
            fetchImpl,
            "POST",
            sleepImpl,
          );
          if (!child.id) throw new Error("threads_carousel_child_missing");
          await waitForThreadsContainer(runtime, child.id, fetchImpl, sleepImpl, nowImpl);
          children.push(child.id);
        }
        const parent = await callThreadsWithRetry(
          runtime,
          "me/threads",
          { media_type: "CAROUSEL", text: parts[0], children: children.join(",") },
          fetchImpl,
          "POST",
          sleepImpl,
        );
        if (!parent.id) throw new Error("threads_carousel_parent_missing");
        await waitForThreadsContainer(runtime, parent.id, fetchImpl, sleepImpl, nowImpl);
        firstContainer = parent.id;
      } catch (error) {
        if (carouselAttempt === 0 && isInvalidCarouselError(error)) {
          await sleepImpl(runtime.retryDelayMs);
          continue;
        }
        throw error;
      }
    }
  } else if (ids.length === 0 && mediaItems[0]) {
    const item = mediaItems[0];
    const container = await callThreadsWithRetry(
      runtime,
      "me/threads",
      {
        media_type: item.type,
        text: parts[0],
        [item.type === "VIDEO" ? "video_url" : "image_url"]: item.vpsUrl,
      },
      fetchImpl,
      "POST",
      sleepImpl,
    );
    if (container.id) {
      await waitForThreadsContainer(runtime, container.id, fetchImpl, sleepImpl, nowImpl);
      firstContainer = container.id;
    }
  } else if (ids.length === 0) {
    const container = await callThreadsWithRetry(
      runtime,
      "me/threads",
      { media_type: "TEXT", text: parts[0] },
      fetchImpl,
      "POST",
      sleepImpl,
    );
    if (container.id) {
      await waitForThreadsContainer(runtime, container.id, fetchImpl, sleepImpl, nowImpl);
      firstContainer = container.id;
    }
  }

  if (firstContainer) {
    const published = await ambiguousExternalMutation("threads", () =>
      callThreadsWithRetry(runtime, "me/threads_publish", { creation_id: firstContainer }, fetchImpl, "POST", sleepImpl),
    );
    if (!published.id) return { ok: false, error: "threads_publish_missing" };
    ids.push(published.id);
  }
  let parentId = ids.at(-1);
  if (!parentId) return { ok: false, error: "threads_container_missing" };
  for (const part of parts.slice(ids.length)) {
    try {
      const reply = await callThreadsWithRetry(
        runtime,
        "me/threads",
        { media_type: "TEXT", text: part, reply_to_id: parentId },
        fetchImpl,
        "POST",
        sleepImpl,
      );
      if (!reply.id) return { partial: true, ids, error: "threads_reply_container_missing", retryable: true };
      await waitForThreadsContainer(runtime, reply.id, fetchImpl, sleepImpl, nowImpl);
      const replyPublish = await ambiguousExternalMutation("threads", () =>
        callThreadsWithRetry(runtime, "me/threads_publish", { creation_id: reply.id }, fetchImpl, "POST", sleepImpl),
      );
      if (!replyPublish.id) return { partial: true, ids, error: "threads_reply_publish_missing", retryable: true };
      ids.push(replyPublish.id);
      parentId = replyPublish.id;
    } catch (error) {
      return { partial: true, ids, error: String(error instanceof Error ? error.message : error), retryable: true };
    }
  }
  return {
    ok: ids.length > 0,
    id: ids[0] ?? null,
    ids,
    url: null,
    urls: [],
    partial: ids.length < parts.length,
  };
}

export async function verifyThreadsPost(
  id: string,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
  target: ThreadsTarget = "threads_ru",
): Promise<{ id: string; url: string | null }> {
  const runtime = threadsRuntime(config, target);
  if (!runtime) throw new Error(`missing ${threadsCredentials(config, target).envName}`);
  const post = await callThreads(runtime, id, { fields: "id,permalink" }, fetchImpl, "GET");
  if (post.id !== id) throw new Error("Threads verification returned a different post");
  return { id, url: post.permalink?.replace("threads.net", "threads.com") ?? null };
}

async function callThreadsWithRetry(
  runtime: ThreadsRuntime,
  endpoint: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
  method: "GET" | "POST" = "POST",
  sleepImpl: SleepImplementation = defaultSleep,
): Promise<ThreadsResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await callThreads(runtime, endpoint, payload, fetchImpl, method);
    } catch (error) {
      lastError = error;
      if (!isRetryableThreadsError(error)) throw error;
      await sleepImpl(runtime.retryDelayMs * (attempt + 1));
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

function isInvalidCarouselError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return message.includes("4279004") || (message.includes("carousel") && message.includes("invalid"));
}

async function callThreads(
  runtime: ThreadsRuntime,
  endpoint: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
  method: "GET" | "POST" = "POST",
): Promise<ThreadsResponse> {
  const url = new URL(`https://graph.threads.net/v1.0/${endpoint}`);
  const body = formBody({ ...payload, access_token: runtime.accessToken });
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

async function waitForThreadsContainer(
  runtime: ThreadsRuntime,
  id: string,
  fetchImpl: typeof fetch,
  sleepImpl: SleepImplementation,
  nowImpl: NowImplementation,
): Promise<void> {
  const deadline = nowImpl() + runtime.containerTimeoutSeconds * 1000;
  while (nowImpl() < deadline) {
    const status = await callThreads(runtime, id, { fields: "status,error_message" }, fetchImpl, "GET");
    if (status.status === "FINISHED") return;
    if (status.status === "ERROR" || status.status === "EXPIRED")
      throw new Error(`Threads container ${id} failed: ${status.error_message ?? status.status}`);
    await sleepImpl(2000);
  }
  throw new Error(`Threads container ${id} timed out`);
}

function threadsRuntime(config: BackendConfig, target: ThreadsTarget): ThreadsRuntime | null {
  const { accessToken } = threadsCredentials(config, target);
  return accessToken
    ? {
        accessToken,
        retryDelayMs: config.THREADS_RETRY_DELAY_MS,
        containerTimeoutSeconds: config.THREADS_CONTAINER_TIMEOUT_SECONDS,
      }
    : null;
}
