import type { BackendConfig } from "../../foundation/config.js";
import { externalFetch, redactExternalSecrets, retryAfterSecondsFromHeaders } from "../../foundation/http.js";
import type { PublishResult } from "../../publishing/errors.js";
import { HttpPublishError } from "../../publishing/errors.js";
import { payloadMedia, payloadText } from "./payload.js";

type GraphResponse = {
  id?: string;
  permalink?: string;
  status?: string;
  status_code?: string;
  error?: { code?: number; message?: string };
};

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
  const creation = await graphPost(
    config,
    `${config.INSTAGRAM_USER_ID}/media`,
    {
      media_type: "STORIES",
      ...(media.type === "VIDEO" ? { video_url: publicUrl } : { image_url: publicUrl }),
      ...(payloadText(payload) ? { caption: payloadText(payload).slice(0, 2200) } : {}),
    },
    fetchImpl,
  );
  if (!creation.id) return { ok: false, error: JSON.stringify(creation) };

  await waitForContainer(config, creation.id, fetchImpl);
  const published = await publishReadyContainer(config, creation.id, fetchImpl);
  if (!published.id) return { ok: false, error: JSON.stringify(published) };

  let permalink: string | null = null;
  try {
    permalink = (await graphGet(config, published.id, { fields: "permalink" }, fetchImpl)).permalink ?? null;
  } catch {
    // Publishing succeeded; a permalink lookup failure must not retry the story.
  }
  return { ok: true, id: published.id, url: permalink, raw: published };
}

async function waitForContainer(config: BackendConfig, creationId: string, fetchImpl: typeof fetch): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await graphGet(config, creationId, { fields: "status_code,status" }, fetchImpl);
    const code = status.status_code ?? status.status;
    if (code === "FINISHED") return;
    if (code === "ERROR") throw new Error(JSON.stringify(status));
    await delay(5_000);
  }
  throw new Error(`instagram_container_timeout:${creationId}`);
}

async function publishReadyContainer(config: BackendConfig, creationId: string, fetchImpl: typeof fetch): Promise<GraphResponse> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await graphPost(config, `${config.INSTAGRAM_USER_ID}/media_publish`, { creation_id: creationId }, fetchImpl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < 5 && (message.includes("2207027") || message.includes("Media ID is not available"))) {
        await delay(5_000);
        continue;
      }
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
  const version = host === "graph.instagram.com" ? config.INSTAGRAM_GRAPH_API_VERSION : config.FACEBOOK_GRAPH_API_VERSION;
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
