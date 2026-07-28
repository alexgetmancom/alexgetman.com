import type { BackendConfig } from "../foundation/config.js";
import { ExternalHttpError, requestJson } from "../foundation/http.js";
import type { InstagramMetadata } from "../publishing/video-types.js";

type ZernioPost = {
  _id?: string;
  id?: string;
  post?: ZernioPost;
  platforms?: Array<{ platform?: string; platformPostId?: string; platformPostUrl?: string }>;
  platformAnalytics?: Array<{ platform?: string; platformPostId?: string; platformPostUrl?: string }>;
};

type ZernioDuplicateError = {
  error?: string;
  details?: {
    accountId?: string;
    platform?: string;
    existingPostId?: string;
  };
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
  let post: ZernioPost;
  try {
    post = await requestJson<ZernioPost>(fetchImpl, api("posts"), {
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
  } catch (error) {
    const existingPostId = matchingDuplicatePostId(error, input.accountId);
    if (!existingPostId) throw error;
    // Zernio returns this conflict after an earlier request reached the
    // provider but its response was lost or the durable job was retried. The
    // provider's existing post is the successful result of this logical target.
    return { providerPostId: existingPostId, externalId: null, url: null };
  }
  const resolved = post.post ?? post;
  const platform = [...(resolved.platforms ?? []), ...(resolved.platformAnalytics ?? [])].find((item) => item.platform === "instagram");
  const id = postId(post);
  if (!id) throw new Error("Zernio did not return a post ID");
  return { providerPostId: id, externalId: platform?.platformPostId ?? null, url: platform?.platformPostUrl ?? null };
}

function matchingDuplicatePostId(error: unknown, accountId: string): string | null {
  if (!(error instanceof ExternalHttpError) || error.status !== 409 || !error.body) return null;
  let response: ZernioDuplicateError;
  try {
    response = JSON.parse(error.body) as ZernioDuplicateError;
  } catch {
    return null;
  }
  const details = response.details;
  if (
    response.error !== "This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours." ||
    details?.accountId !== accountId ||
    details.platform !== "instagram" ||
    typeof details.existingPostId !== "string" ||
    !details.existingPostId
  )
    return null;
  return details.existingPostId;
}
