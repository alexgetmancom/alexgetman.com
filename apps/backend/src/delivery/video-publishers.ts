import type { BackendConfig } from "../foundation/config.js";
import { youtubeAccessToken } from "../foundation/external/youtube.js";
import { formBody, requestJson } from "../foundation/http.js";
import type { InstagramMetadata, YouTubeMetadata } from "../publishing/video-types.js";

type YouTubeVideo = { id: string };
type InstagramContainer = { id: string };
type InstagramStatus = { status_code?: string; status?: string };
type InstagramPublish = { id: string };

export class InstagramContainerProcessingError extends Error {}
export class InstagramContainerInvalidError extends Error {}

function instagramGraphBase(config: BackendConfig): string {
  const host = config.INSTAGRAM_ACCESS_TOKEN?.startsWith("IG") ? "graph.instagram.com" : "graph.facebook.com";
  const version = host === "graph.instagram.com" ? config.INSTAGRAM_GRAPH_API_VERSION : config.FACEBOOK_GRAPH_API_VERSION;
  return `https://${host}/${version}`;
}

export async function prepareYouTubeVideo(
  config: BackendConfig,
  filePath: string,
  metadata: YouTubeMetadata,
  publishAt: string,
): Promise<{ id: string; url: string }> {
  const token = await youtubeAccessToken(config);
  const file = Bun.file(filePath);
  const init = await fetch(
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
          defaultLanguage: "ru",
          defaultAudioLanguage: "ru",
        },
        status: { privacyStatus: "private", publishAt, selfDeclaredMadeForKids: false },
        recordingDetails: {
          recordingDate: publishAt,
        },
      }),
    },
  );
  if (!init.ok) throw new Error(`YouTube upload session failed: ${init.status} ${await init.text()}`);
  const location = init.headers.get("location");
  if (!location) throw new Error("YouTube did not return an upload location.");
  const uploaded = await fetch(location, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(file.size) },
    body: file,
  });
  if (!uploaded.ok) throw new Error(`YouTube upload failed: ${uploaded.status} ${await uploaded.text()}`);
  const video = (await uploaded.json()) as YouTubeVideo;
  return { id: video.id, url: `https://www.youtube.com/watch?v=${video.id}` };
}

export async function prepareInstagramReel(config: BackendConfig, publicUrl: string, metadata: InstagramMetadata): Promise<{ id: string }> {
  // Instagram has a single caption field. Hashtags are part of the caption the
  // creator writes, rather than a second field appended during publication.
  const caption = metadata.caption.trim();
  const response = await requestJson<InstagramContainer>(fetch, `${instagramGraphBase(config)}/${config.INSTAGRAM_USER_ID}/media`, {
    method: "POST",
    body: formBody({
      media_type: "REELS",
      video_url: publicUrl,
      caption,
      share_to_feed: true,
      access_token: config.INSTAGRAM_ACCESS_TOKEN,
    }),
  });
  return { id: response.id };
}

export async function instagramContainerReady(config: BackendConfig, containerId: string): Promise<void> {
  const status = await requestJson<InstagramStatus>(
    fetch,
    `${instagramGraphBase(config)}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(config.INSTAGRAM_ACCESS_TOKEN ?? "")}`,
  );
  if (["ERROR", "EXPIRED"].includes(status.status_code ?? ""))
    throw new InstagramContainerInvalidError(`Instagram container ${status.status_code}: ${status.status ?? "unknown error"}`);
  if (status.status_code !== "FINISHED")
    throw new InstagramContainerProcessingError(`Instagram container ${status.status_code ?? "PROCESSING"}`);
}

export async function publishInstagramReel(config: BackendConfig, containerId: string): Promise<{ id: string; url: string }> {
  const published = await requestJson<InstagramPublish>(fetch, `${instagramGraphBase(config)}/${config.INSTAGRAM_USER_ID}/media_publish`, {
    method: "POST",
    body: formBody({ creation_id: containerId, access_token: config.INSTAGRAM_ACCESS_TOKEN }),
  });
  return { id: published.id, url: `https://www.instagram.com/reel/${published.id}/` };
}
