import type { BackendConfig } from "../../foundation/config.js";
import { externalFetch, retryAfterSecondsFromHeaders } from "../../foundation/http.js";
import { redactExternalSecrets } from "../../foundation/redact.js";
import type { PublishResult } from "../../publishing/errors.js";
import { HttpPublishError } from "../../publishing/errors.js";
import { ambiguousExternalMutation, isAmbiguousPublicationError } from "../ambiguous-publication.js";
import { InstagramContainerInvalidError, isExpiredInstagramContainer } from "./instagram-container.js";
import { payloadMedia } from "./payload.js";

type GraphResponse = {
  id?: string;
  permalink?: string;
  status?: string;
  status_code?: string;
  error?: { code?: number; message?: string };
};

// Worst-case wall time for one story, spent inside a single worker slot:
// CONTAINER_ATTEMPTS × (READY_POLLS + PUBLISH_ATTEMPTS) × POLL_DELAY_MS.
// Keep the product bounded — these loops block every other delivery behind them.
const POLL_DELAY_MS = 5_000;
const READY_POLLS = 30;
const PUBLISH_ATTEMPTS = 5;
const CONTAINER_ATTEMPTS = 2;

export async function publishInstagramStory(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  if (!config.ENABLE_INSTAGRAM_STORIES) return { ok: false, skipped: true, reason: "instagram_stories_disabled" };
  if (!config.INSTAGRAM_ACCESS_TOKEN) throw new Error("missing INSTAGRAM_ACCESS_TOKEN");
  if (!config.INSTAGRAM_USER_ID) throw new Error("missing INSTAGRAM_USER_ID");

  const media = payloadMedia(payload).find((item) => item.storyVpsUrl || item.vpsUrl);
  if (!media) return { ok: false, skipped: true, reason: "missing_public_media_url" };
  const publicUrl = media.storyVpsUrl || media.vpsUrl;
  if (!publicUrl) return { ok: false, skipped: true, reason: "missing_public_media_url" };
  let published: GraphResponse | null = null;
  for (let containerAttempt = 0; containerAttempt < CONTAINER_ATTEMPTS && !published; containerAttempt += 1) {
    try {
      const creation = await graphPost(
        config,
        `${config.INSTAGRAM_USER_ID}/media`,
        {
          media_type: "STORIES",
          ...(media.type === "VIDEO" ? { video_url: publicUrl } : { image_url: publicUrl }),
        },
        fetchImpl,
      );
      if (!creation.id) return { ok: false, error: JSON.stringify(creation) };
      await waitForContainer(config, creation.id, fetchImpl);
      published = await publishReadyContainer(config, creation.id, fetchImpl);
    } catch (error) {
      if (containerAttempt < CONTAINER_ATTEMPTS - 1 && isExpiredInstagramContainer(error)) {
        await delay(POLL_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
  if (!published?.id) return { ok: false, error: JSON.stringify(published) };

  let permalink: string | null = null;
  try {
    permalink = (await graphGet(config, published.id, { fields: "permalink" }, fetchImpl)).permalink ?? null;
  } catch {
    // Publishing succeeded; a permalink lookup failure must not retry the story.
  }
  return { ok: true, id: published.id, url: permalink, raw: published };
}

export async function verifyInstagramPublication(
  id: string,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; url: string | null }> {
  const media = await graphGet(config, id, { fields: "id,permalink" }, fetchImpl);
  if (media.id !== id) throw new Error("Instagram verification did not return the expected media");
  return { id, url: media.permalink ?? null };
}

async function waitForContainer(config: BackendConfig, creationId: string, fetchImpl: typeof fetch): Promise<void> {
  for (let attempt = 0; attempt < READY_POLLS; attempt += 1) {
    const status = await graphGet(config, creationId, { fields: "status_code,status" }, fetchImpl);
    const code = status.status_code ?? status.status;
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") throw new InstagramContainerInvalidError(JSON.stringify(status));
    await delay(POLL_DELAY_MS);
  }
  throw new Error(`instagram_container_timeout:${creationId}`);
}

async function publishReadyContainer(config: BackendConfig, creationId: string, fetchImpl: typeof fetch): Promise<GraphResponse> {
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
    try {
      return await ambiguousExternalMutation("instagram_stories", () =>
        graphPost(config, `${config.INSTAGRAM_USER_ID}/media_publish`, { creation_id: creationId }, fetchImpl),
      );
    } catch (error) {
      if (isAmbiguousPublicationError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // A container that looks dead right after FINISHED is usually Meta's read
      // replica lagging, so retry in place first; only the last attempt escalates
      // to the caller's rebuild-the-container path.
      if (attempt < PUBLISH_ATTEMPTS && isExpiredInstagramContainer(error)) {
        await delay(POLL_DELAY_MS);
        continue;
      }
      if (isExpiredInstagramContainer(error)) throw new InstagramContainerInvalidError(message);
      throw error;
    }
  }
  throw new Error("failed_to_publish_instagram_story");
}

async function graphPost(
  config: BackendConfig,
  path: string,
  payload: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<GraphResponse> {
  return graphRequest(config, path, fetchImpl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...payload, access_token: instagramToken(config) }),
  });
}

async function graphGet(
  config: BackendConfig,
  path: string,
  query: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<GraphResponse> {
  const params = new URLSearchParams({ ...query, access_token: instagramToken(config) });
  return graphRequest(config, `${path}?${params}`, fetchImpl);
}

async function graphRequest(config: BackendConfig, path: string, fetchImpl: typeof fetch, init?: RequestInit): Promise<GraphResponse> {
  const host = config.INSTAGRAM_ACCESS_TOKEN?.startsWith("IG") ? "graph.instagram.com" : "graph.facebook.com";
  const version = config.INSTAGRAM_GRAPH_API_VERSION;
  const response = await externalFetch(fetchImpl, `https://${host}/${version}/${path.replace(/^\/+/, "")}`, init);
  const body = await response.text();
  if (!response.ok) {
    const safeBody = redactExternalSecrets(body);
    throw new HttpPublishError(
      `Instagram API ${response.status}: ${safeBody}`,
      response.status,
      safeBody,
      retryAfterSecondsFromHeaders(response.headers),
    );
  }
  return body ? (JSON.parse(body) as GraphResponse) : {};
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function instagramToken(config: BackendConfig): string {
  if (!config.INSTAGRAM_ACCESS_TOKEN) throw new Error("missing Instagram access token");
  return config.INSTAGRAM_ACCESS_TOKEN;
}
