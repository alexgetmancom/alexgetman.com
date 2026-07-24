import type { BackendConfig } from "../../foundation/config.js";
import { ExternalHttpError, requestJson } from "../../foundation/http.js";
import type { PublishResult } from "../../publishing/errors.js";
import { payloadMedia, payloadText, stripLeadingEmojis } from "./payload.js";

type FacebookResponse = {
  id?: string;
};

export async function publishToFacebook(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  if (!config.FACEBOOK_PAGE_ID || !config.FACEBOOK_PAGE_ACCESS_TOKEN) return { skipped: true, reason: "missing Facebook credentials" };
  const text = stripLeadingEmojis(payloadText(payload));
  const media = payloadMedia(payload).filter((item) => item.vpsUrl);
  if (media.some((item) => item.type === "VIDEO")) {
    const video = media.find((item) => item.type === "VIDEO");
    if (!video) throw new Error("Facebook video selection failed");
    const res = await callFacebook(
      config,
      `${config.FACEBOOK_PAGE_ID}/videos`,
      { file_url: video.vpsUrl, description: text },
      fetchImpl,
      true,
    );
    return { ok: Boolean(res.id), id: res.id ?? null, raw: res };
  }
  if (media.length > 0) {
    // A child photo can become invalid between upload and /feed. A 400 with an
    // invalid media_fbid proves the parent post was not created, so rebuilding
    // the complete album is safe and avoids leaving the target failed.
    for (let albumAttempt = 0; albumAttempt < 2; albumAttempt += 1) {
      try {
        const photoIds: string[] = [];
        for (const item of media) {
          const photo = await callFacebook(config, `${config.FACEBOOK_PAGE_ID}/photos`, { url: item.vpsUrl, published: false }, fetchImpl);
          if (!photo.id) throw new Error("facebook_album_photo_missing_id");
          photoIds.push(photo.id);
        }
        const res = await callFacebook(
          config,
          `${config.FACEBOOK_PAGE_ID}/feed`,
          { message: text, attached_media: JSON.stringify(photoIds.map((id) => ({ media_fbid: id }))) },
          fetchImpl,
        );
        return { ok: Boolean(res.id), id: res.id ?? null, ids: photoIds, raw: res };
      } catch (error) {
        if (albumAttempt === 0 && isInvalidFacebookAlbumError(error)) continue;
        throw error;
      }
    }
  }
  const res = await callFacebook(config, `${config.FACEBOOK_PAGE_ID}/feed`, { message: text }, fetchImpl);
  return { ok: Boolean(res.id), id: res.id ?? null, raw: res };
}

function isInvalidFacebookAlbumError(error: unknown): boolean {
  if (!(error instanceof ExternalHttpError) || error.status !== 400) return false;
  const body = (error.body ?? error.message).toLowerCase();
  return (body.includes("media_fbid") || body.includes("photo")) && (body.includes("invalid") || body.includes("does not exist"));
}

async function callFacebook(
  config: BackendConfig,
  endpoint: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
  video = false,
): Promise<FacebookResponse> {
  const base = video ? "https://graph-video.facebook.com" : "https://graph.facebook.com";
  const url = `${base}/${config.FACEBOOK_GRAPH_API_VERSION}/${endpoint}`;
  return requestJson<FacebookResponse>(fetchImpl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, access_token: config.FACEBOOK_PAGE_ACCESS_TOKEN }),
  });
}
