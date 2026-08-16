import { InstagramContainerInvalidError, isExpiredInstagramContainer } from "../delivery/social/instagram-container.js";
import type { BackendConfig } from "../foundation/config.js";
import { type InstagramCredentials, instagramCredentialsForLocale, instagramGraphHost } from "../foundation/external/instagram.js";
import { type VideoLocale, youtubeAccessToken } from "../foundation/external/youtube.js";
import { ExternalTransportError, externalFetch, formBody, requestJson } from "../foundation/http.js";
import { httpPublishError } from "../publishing/errors.js";
import type { InstagramMetadata, YouTubeMetadata } from "../publishing/video-types.js";
import { AmbiguousPublicationError, ambiguousExternalMutation } from "./ambiguous-publication.js";
import { absentIfMissing } from "./platform-absence.js";
import { verifyZernioPost } from "./zernio.js";

type YouTubeVideo = { id: string };
type YouTubeVideoList = { items?: Array<{ id?: string }> };
const VIDEO_UPLOAD_TIMEOUT_MS = 30 * 60_000;

/** Every mutable field of `videos.status` this project ever sets. `videos.update`
 * clears any field of the selected part that the request omits, so a status edit
 * has to read these back and resend them verbatim. Adding a field to the type
 * without adding it here silently resets it on the next schedule cancellation. */
const PRESERVED_YOUTUBE_STATUS_FIELDS = [
  "license",
  "embeddable",
  "publicStatsViewable",
  "selfDeclaredMadeForKids",
  "containsSyntheticMedia",
] as const;

type YouTubeStatus = {
  license?: "youtube" | "creativeCommon";
  embeddable?: boolean;
  publicStatsViewable?: boolean;
  selfDeclaredMadeForKids?: boolean;
  containsSyntheticMedia?: boolean;
};
type YouTubeVideoStatus = { items?: Array<{ status?: YouTubeStatus }> };
type InstagramContainer = { id: string };
type InstagramStatus = { status_code?: string; status?: string };
type InstagramPublish = { id: string };

export class InstagramContainerProcessingError extends Error {}
export { InstagramContainerInvalidError };

function instagramGraphBase(config: BackendConfig, accessToken: string): string {
  const host = instagramGraphHost(accessToken);
  const version = config.INSTAGRAM_GRAPH_API_VERSION;
  return `https://${host}/${version}`;
}

export async function prepareYouTubeVideo(
  config: BackendConfig,
  filePath: string,
  metadata: YouTubeMetadata,
  publishAt: string,
  locale: VideoLocale = "ru",
): Promise<{ id: string; url: string }> {
  const token = await youtubeAccessToken(config, fetch, locale);
  const file = Bun.file(filePath);
  const init = await externalFetch(
    fetch,
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,recordingDetails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(file.size),
      },
      body: JSON.stringify({
        snippet: {
          title: metadata.title,
          description: metadata.description,
          tags: metadata.tags,
          categoryId: "20",
          defaultLanguage: locale,
          defaultAudioLanguage: locale,
        },
        status: { privacyStatus: "private", publishAt, selfDeclaredMadeForKids: false },
        recordingDetails: {
          recordingDate: publishAt,
        },
      }),
    },
  );
  if (!init.ok) throw httpPublishError(init, await init.text(), "YouTube upload session");
  const location = init.headers.get("location");
  if (!location) throw new Error("YouTube did not return an upload location.");
  const video = await uploadYouTubeResumable(location, file, VIDEO_UPLOAD_TIMEOUT_MS);
  return { id: video.id, url: `https://www.youtube.com/watch?v=${video.id}` };
}

async function uploadYouTubeResumable(location: string, file: Bun.BunFile, uploadTimeoutMs: number): Promise<YouTubeVideo> {
  try {
    return await putYouTubeBytes(location, file, 0, file.size, uploadTimeoutMs);
  } catch (error) {
    if (!(error instanceof ExternalTransportError)) throw error;
  }
  // The resumable protocol exposes the committed byte range after a lost
  // response, so this provider does not need a manual verification state.
  const status = await queryYouTubeUploadStatus(location, file.size);
  if (status.ok) return (await status.json()) as YouTubeVideo;
  if (status.status !== 308) throw httpPublishError(status, await status.text(), "YouTube upload status");
  const committed = Number(status.headers.get("range")?.match(/bytes=0-(\d+)/)?.[1] ?? -1) + 1;
  if (committed >= file.size) {
    // Every byte arrived but the final representation is still converging.
    // Never send an empty, invalid N-(N-1) range; ask the session again.
    const confirmed = await queryYouTubeUploadStatus(location, file.size);
    if (confirmed.ok) return (await confirmed.json()) as YouTubeVideo;
    throw new AmbiguousPublicationError("youtube_upload", new Error("YouTube received every byte but did not return the video resource"));
  }
  return ambiguousExternalMutation("youtube_upload", () =>
    putYouTubeBytes(location, file.slice(committed), committed, file.size, uploadTimeoutMs),
  );
}

async function queryYouTubeUploadStatus(location: string, total: number): Promise<Response> {
  return externalFetch(fetch, location, {
    method: "PUT",
    headers: { "Content-Length": "0", "Content-Range": `bytes */${total}` },
  });
}

async function putYouTubeBytes(location: string, body: Blob, start: number, total: number, uploadTimeoutMs: number): Promise<YouTubeVideo> {
  const response = await externalFetch(
    fetch,
    location,
    {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(body.size),
        "Content-Range": `bytes ${start}-${total - 1}/${total}`,
      },
      body,
    },
    uploadTimeoutMs,
  );
  if (!response.ok) throw httpPublishError(response, await response.text(), "YouTube upload");
  return (await response.json()) as YouTubeVideo;
}

/** Stops a future YouTube release but deliberately retains the private upload.
 * Do not call for a target that may already have been published. */
export async function keepYouTubeUploadPrivate(config: BackendConfig, videoId: string, locale: VideoLocale = "ru"): Promise<void> {
  const token = await youtubeAccessToken(config, fetch, locale);
  const headers = { Authorization: `Bearer ${token}` };
  const current = await requestJson<YouTubeVideoStatus>(
    fetch,
    `https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(videoId)}`,
    { headers },
  );
  const status = current.items?.[0]?.status;
  if (!status) throw new Error("YouTube upload was not found while cancelling its schedule.");
  await requestJson(fetch, "https://www.googleapis.com/youtube/v3/videos?part=status", {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    // videos.update clears omitted mutable fields in the selected part. Keep
    // the existing status settings and intentionally omit publishAt.
    body: JSON.stringify({ id: videoId, status: { privacyStatus: "private", ...preservedStatusFields(status) } }),
  });
}

export async function verifyYouTubeVideo(
  config: BackendConfig,
  videoId: string,
  locale: VideoLocale = "ru",
): Promise<{ id: string; url: string }> {
  const token = await youtubeAccessToken(config, fetch, locale);
  const response = await requestJson<YouTubeVideoList>(
    fetch,
    `https://www.googleapis.com/youtube/v3/videos?part=id&id=${encodeURIComponent(videoId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.items?.[0]?.id !== videoId) throw new Error("YouTube verification did not find the expected video");
  return { id: videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

/** Whether the platform still has a published video, asked of the platform
 * itself. A public permalink cannot answer this: Instagram serves a login wall
 * with HTTP 200 for a logged-out request whether or not the reel is there, so
 * proving absence over the open web would either never succeed or, worse,
 * succeed for a video that is still live. */
export async function videoTargetIsAbsent(
  config: BackendConfig,
  target: { target: string; externalId: string | null; deliveryProvider: string; providerPostId: string | null },
  locale: VideoLocale,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  if (target.deliveryProvider === "zernio") {
    if (!target.providerPostId) throw new Error("cannot ask the provider about a target with no provider post id");
    return absentIfMissing(() => verifyZernioPost(config, target.providerPostId as string));
  }
  if (!target.externalId) throw new Error(`cannot ask ${target.target} about a target with no external id`);
  if (target.target === "youtube_shorts") return absentIfMissing(() => verifyYouTubeVideo(config, target.externalId as string, locale));
  const { accessToken } = instagramCredentialsForLocale(config, locale);
  if (!accessToken) throw new Error("Instagram credentials are missing");
  return absentIfMissing(() =>
    requestJson<InstagramContainer>(
      fetchImpl,
      `${instagramGraphBase(config, accessToken)}/${target.externalId}?fields=id&access_token=${encodeURIComponent(accessToken)}`,
    ),
  );
}

function preservedStatusFields(status: YouTubeStatus): Partial<YouTubeStatus> {
  return Object.fromEntries(
    PRESERVED_YOUTUBE_STATUS_FIELDS.filter((field) => status[field] != null).map((field) => [field, status[field]]),
  );
}

export async function prepareInstagramReel(
  config: BackendConfig,
  credentials: InstagramCredentials,
  publicUrl: string,
  metadata: InstagramMetadata,
): Promise<{ id: string }> {
  // Instagram has a single caption field. Hashtags are part of the caption the
  // creator writes, rather than a second field appended during publication.
  const caption = metadata.caption.trim();
  const account = requireInstagramAccount(credentials);
  const response = await requestJson<InstagramContainer>(
    fetch,
    `${instagramGraphBase(config, account.accessToken)}/${account.userId}/media`,
    {
      method: "POST",
      body: formBody({
        media_type: "REELS",
        video_url: publicUrl,
        caption,
        share_to_feed: true,
        access_token: account.accessToken,
      }),
    },
  );
  return { id: response.id };
}

export async function instagramContainerReady(
  config: BackendConfig,
  credentials: InstagramCredentials,
  containerId: string,
): Promise<void> {
  const account = requireInstagramAccount(credentials);
  const status = await requestJson<InstagramStatus>(
    fetch,
    `${instagramGraphBase(config, account.accessToken)}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(account.accessToken)}`,
  );
  if (["ERROR", "EXPIRED"].includes(status.status_code ?? ""))
    throw new InstagramContainerInvalidError(`Instagram container ${status.status_code}: ${status.status ?? "unknown error"}`);
  if (status.status_code !== "FINISHED")
    throw new InstagramContainerProcessingError(`Instagram container ${status.status_code ?? "PROCESSING"}`);
}

export async function publishInstagramReel(
  config: BackendConfig,
  credentials: InstagramCredentials,
  containerId: string,
): Promise<{ id: string; url: string }> {
  const account = requireInstagramAccount(credentials);
  let published: InstagramPublish;
  try {
    published = await ambiguousExternalMutation("instagram_reels", () =>
      requestJson<InstagramPublish>(fetch, `${instagramGraphBase(config, account.accessToken)}/${account.userId}/media_publish`, {
        method: "POST",
        body: formBody({ creation_id: containerId, access_token: account.accessToken }),
      }),
    );
  } catch (error) {
    // A 400 from media_publish can mean the creation_id died after its last
    // successful status poll. The worker recognises this class and starts a
    // fresh prepare cycle instead of retrying the dead container.
    if (isExpiredInstagramContainer(error, 400))
      throw new InstagramContainerInvalidError(String(error instanceof Error ? error.message : error));
    throw error;
  }
  return { id: published.id, url: `https://www.instagram.com/reel/${published.id}/` };
}

function requireInstagramAccount(credentials: InstagramCredentials): { accessToken: string; userId: string } {
  if (!credentials.accessToken || !credentials.userId) throw new Error("Instagram credentials are missing");
  return { accessToken: credentials.accessToken, userId: credentials.userId };
}
