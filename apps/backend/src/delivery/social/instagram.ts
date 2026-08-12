import type { BackendConfig } from "../../foundation/config.js";
import { type InstagramCredentials, instagramGraphHost } from "../../foundation/external/instagram.js";
import { externalFetch } from "../../foundation/http.js";
import { redactExternalSecrets } from "../../foundation/redact.js";
import type { PublishResult } from "../../publishing/errors.js";
import { httpPublishError } from "../../publishing/errors.js";
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

type MediaProbe = {
  status: number | "unreachable";
  contentType: string | null;
  contentLength: string | null;
  error?: string;
};
type SleepImplementation = (milliseconds: number) => Promise<void>;

// Worst-case wall time for one story, spent inside a single worker slot:
// CONTAINER_ATTEMPTS × (READY_POLLS + PUBLISH_ATTEMPTS) × POLL_DELAY_MS.
// Keep the product bounded — these loops block every other delivery behind them.
const POLL_DELAY_MS = 5_000;
const READY_POLLS = 30;
const PUBLISH_ATTEMPTS = 5;
const CONTAINER_ATTEMPTS = 2;
const defaultSleep: SleepImplementation = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function publishInstagramStory(
  payload: Record<string, unknown>,
  config: BackendConfig,
  credentials: InstagramCredentials,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: SleepImplementation = defaultSleep,
): Promise<PublishResult> {
  if (!credentials.accessToken) throw new Error("missing Instagram access token");
  if (!credentials.userId) throw new Error("missing Instagram user id");

  const media = payloadMedia(payload).find((item) => item.storyVpsUrl || item.vpsUrl);
  if (!media) return { ok: false, skipped: true, reason: "missing_public_media_url" };
  const publicUrl = media.storyVpsUrl || media.vpsUrl;
  if (!publicUrl) return { ok: false, skipped: true, reason: "missing_public_media_url" };
  let published: GraphResponse | null = null;
  for (let containerAttempt = 0; containerAttempt < CONTAINER_ATTEMPTS && !published; containerAttempt += 1) {
    try {
      const creation = await graphPost(
        config,
        credentials,
        `${credentials.userId}/media`,
        {
          media_type: "STORIES",
          ...(media.type === "VIDEO" ? { video_url: publicUrl } : { image_url: publicUrl }),
        },
        fetchImpl,
      );
      if (!creation.id) return { ok: false, error: JSON.stringify(creation) };
      await waitForContainer(config, credentials, creation.id, publicUrl, media.type, fetchImpl, sleepImpl);
      published = await publishReadyContainer(config, credentials, creation.id, fetchImpl, sleepImpl);
    } catch (error) {
      if (containerAttempt < CONTAINER_ATTEMPTS - 1 && isExpiredInstagramContainer(error)) {
        await sleepImpl(POLL_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
  if (!published?.id) return { ok: false, error: JSON.stringify(published) };

  let permalink: string | null = null;
  try {
    permalink = (await graphGet(config, credentials, published.id, { fields: "permalink" }, fetchImpl)).permalink ?? null;
  } catch {
    // Publishing succeeded; a permalink lookup failure must not retry the story.
  }
  return { ok: true, id: published.id, url: permalink, raw: published };
}

export async function verifyInstagramPublication(
  id: string,
  config: BackendConfig,
  credentials: InstagramCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; url: string | null }> {
  const media = await graphGet(config, credentials, id, { fields: "id,permalink" }, fetchImpl);
  if (media.id !== id) throw new Error("Instagram verification did not return the expected media");
  return { id, url: media.permalink ?? null };
}

async function waitForContainer(
  config: BackendConfig,
  credentials: InstagramCredentials,
  creationId: string,
  publicUrl: string,
  mediaType: string,
  fetchImpl: typeof fetch,
  sleepImpl: SleepImplementation,
): Promise<void> {
  for (let attempt = 0; attempt < READY_POLLS; attempt += 1) {
    const status = await graphGet(config, credentials, creationId, { fields: "status_code,status" }, fetchImpl);
    const code = status.status_code ?? status.status;
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      const mediaProbe = await probePublicMedia(publicUrl, fetchImpl);
      throw new InstagramContainerInvalidError(
        `Instagram container rejected media: ${JSON.stringify({
          containerId: creationId,
          statusCode: code,
          providerStatus: status.status ?? null,
          providerError: status.error ?? null,
          mediaType,
          publicUrl,
          mediaProbe,
        })}`,
      );
    }
    await sleepImpl(POLL_DELAY_MS);
  }
  throw new Error(`instagram_container_timeout:${creationId}`);
}

async function probePublicMedia(publicUrl: string, fetchImpl: typeof fetch): Promise<MediaProbe> {
  try {
    const response = await externalFetch(fetchImpl, publicUrl, { method: "HEAD" });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
    };
  } catch (error) {
    return {
      status: "unreachable",
      contentType: null,
      contentLength: null,
      error: redactExternalSecrets(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function publishReadyContainer(
  config: BackendConfig,
  credentials: InstagramCredentials,
  creationId: string,
  fetchImpl: typeof fetch,
  sleepImpl: SleepImplementation,
): Promise<GraphResponse> {
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
    try {
      return await ambiguousExternalMutation("instagram_stories", () =>
        graphPost(config, credentials, `${credentials.userId}/media_publish`, { creation_id: creationId }, fetchImpl),
      );
    } catch (error) {
      if (isAmbiguousPublicationError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // A container that looks dead right after FINISHED is usually Meta's read
      // replica lagging, so retry in place first; only the last attempt escalates
      // to the caller's rebuild-the-container path.
      if (attempt < PUBLISH_ATTEMPTS && isExpiredInstagramContainer(error)) {
        await sleepImpl(POLL_DELAY_MS);
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
  credentials: InstagramCredentials,
  path: string,
  payload: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<GraphResponse> {
  return graphRequest(config, credentials, path, fetchImpl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...payload, access_token: instagramToken(credentials) }),
  });
}

async function graphGet(
  config: BackendConfig,
  credentials: InstagramCredentials,
  path: string,
  query: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<GraphResponse> {
  const params = new URLSearchParams({ ...query, access_token: instagramToken(credentials) });
  return graphRequest(config, credentials, `${path}?${params}`, fetchImpl);
}

async function graphRequest(
  config: BackendConfig,
  credentials: InstagramCredentials,
  path: string,
  fetchImpl: typeof fetch,
  init?: RequestInit,
): Promise<GraphResponse> {
  const host = instagramGraphHost(credentials.accessToken ?? "");
  const version = config.INSTAGRAM_GRAPH_API_VERSION;
  const response = await externalFetch(fetchImpl, `https://${host}/${version}/${path.replace(/^\/+/, "")}`, init);
  const body = await response.text();
  if (!response.ok) throw httpPublishError(response, body, "Instagram API");
  return body ? (JSON.parse(body) as GraphResponse) : {};
}

function instagramToken(credentials: InstagramCredentials): string {
  if (!credentials.accessToken) throw new Error("missing Instagram access token");
  return credentials.accessToken;
}
