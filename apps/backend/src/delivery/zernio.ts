import type { BackendConfig } from "../foundation/config.js";
import { requestJson } from "../foundation/http.js";
import type { InstagramMetadata } from "../publishing/video-types.js";

type ZernioPost = {
  _id?: string;
  id?: string;
  post?: ZernioPost;
  platforms?: Array<{ platform?: string; platformPostId?: string; platformPostUrl?: string }>;
  platformAnalytics?: Array<{ platform?: string; platformPostId?: string; platformPostUrl?: string }>;
};

function api(path: string): string {
  return `https://zernio.com/api/v1/${path}`;
}

function postId(post: ZernioPost): string | null {
  return post._id ?? post.id ?? post.post?._id ?? post.post?.id ?? null;
}

/** Zernio publishes at the durable publish job time. The request ID fences retries of this logical target. */
export async function publishZernioInstagramReel(
  config: BackendConfig,
  input: { accountId: string; publicUrl: string; metadata: InstagramMetadata; requestId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ providerPostId: string; externalId: string | null; url: string | null }> {
  if (!config.ZERNIO_API_KEY) throw new Error("ZERNIO_API_KEY is missing");
  const post = await requestJson<ZernioPost>(fetchImpl, api("posts"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.ZERNIO_API_KEY}`,
      "Content-Type": "application/json",
      "x-request-id": input.requestId,
    },
    body: JSON.stringify({
      content: input.metadata.caption.trim(),
      mediaItems: [{ type: "video", url: input.publicUrl }],
      platforms: [
        {
          platform: "instagram",
          accountId: input.accountId,
          platformSpecificData: { contentType: "reels", shareToFeed: true },
        },
      ],
      publishNow: true,
    }),
  });
  const resolved = post.post ?? post;
  const platform = [...(resolved.platforms ?? []), ...(resolved.platformAnalytics ?? [])].find((item) => item.platform === "instagram");
  const id = postId(post);
  if (!id) throw new Error("Zernio did not return a post ID");
  return { providerPostId: id, externalId: platform?.platformPostId ?? null, url: platform?.platformPostUrl ?? null };
}
