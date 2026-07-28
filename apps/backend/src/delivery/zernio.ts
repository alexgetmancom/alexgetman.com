import type { BackendConfig } from "../foundation/config.js";
import { ExternalHttpError, requestJson } from "../foundation/http.js";
import type { InstagramMetadata } from "../publishing/video-types.js";
import { AmbiguousPublicationError, isAmbiguousTransportFailure } from "./ambiguous-publication.js";

type ZernioPost = {
  _id?: string;
  id?: string;
  post?: ZernioPost;
  existingPost?: ZernioPost;
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
  return post._id ?? post.id ?? post.post?._id ?? post.post?.id ?? post.existingPost?._id ?? post.existingPost?.id ?? null;
}

/** Zernio publishes at the durable publish job time. The request ID fences retries of this logical target. */
export async function publishZernioInstagramReel(
  config: BackendConfig,
  input: { accountId: string; publicUrl: string; metadata: InstagramMetadata; requestId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ providerPostId: string; externalId: string | null; url: string | null }> {
  if (!config.ZERNIO_API_KEY) throw new Error("ZERNIO_API_KEY is missing");
  const create = () =>
    requestJson<ZernioPost>(fetchImpl, api("posts"), {
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return zernioPublishResult(await create());
    } catch (error) {
      const existingPostId = matchingDuplicatePostId(error, input.accountId);
      if (existingPostId) {
        // Zernio returns this conflict after an earlier request reached the
        // provider but its response was lost or the durable job was retried.
        try {
          const existing = await requestJson<ZernioPost>(fetchImpl, api(`posts/${encodeURIComponent(existingPostId)}`), {
            headers: { Authorization: `Bearer ${config.ZERNIO_API_KEY}` },
          });
          return zernioPublishResult(existing, existingPostId);
        } catch {
          // The conflict itself is authoritative proof that the exact post
          // exists. The lookup only enriches the result with platform fields.
          return { providerPostId: existingPostId, externalId: null, url: null };
        }
      }
      if (!isAmbiguousTransportFailure(error)) throw error;
      // The same request ID is Zernio's documented idempotency key. One
      // immediate replay is a read/reconciliation operation in effect: it
      // returns `existingPost` rather than creating another post.
      if (attempt === 0) continue;
      throw new AmbiguousPublicationError("zernio", error);
    }
  }
  throw new Error("Zernio publication loop exhausted unexpectedly");
}

function zernioPublishResult(
  post: ZernioPost,
  expectedPostId?: string,
): { providerPostId: string; externalId: string | null; url: string | null } {
  const resolved = post.post ?? post.existingPost ?? post;
  const platform = [...(resolved.platforms ?? []), ...(resolved.platformAnalytics ?? [])].find((item) => item.platform === "instagram");
  const id = postId(post);
  if (!id) throw new Error("Zernio did not return a post ID");
  if (expectedPostId && id !== expectedPostId) throw new Error("Zernio returned a different post during reconciliation");
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
