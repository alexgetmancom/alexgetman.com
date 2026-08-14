import type { BackendConfig } from "../foundation/config.js";
import { zernioRequest } from "../foundation/external/zernio.js";
import { ExternalHttpError } from "../foundation/http.js";
import type { PublishResult } from "../publishing/errors.js";
import type { ClaimedPublishJob } from "../publishing/queue.js";
import type { InstagramMetadata } from "../publishing/video-types.js";
import { AmbiguousPublicationError, isAmbiguousTransportFailure } from "./ambiguous-publication.js";
import { payloadMedia, payloadText } from "./social/payload.js";

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

function postId(post: ZernioPost): string | null {
  return post._id ?? post.id ?? post.post?._id ?? post.post?.id ?? post.existingPost?._id ?? post.existingPost?.id ?? null;
}

/**
 * A post through the provider, for the targets that are not video.
 *
 * Threads and Instagram Stories reach the same endpoint the Reel does; what
 * differs is the platform name and, for a Story, the content type. The request
 * id fences retries of one logical target, so a repeat of the same delivery
 * returns the post that already exists rather than making a second one.
 */
async function publishZernioPost(
  config: BackendConfig,
  input: {
    accountId: string;
    platform: "threads" | "instagram";
    content: string;
    mediaUrls: { url: string; type: "image" | "video" }[];
    contentType?: "story";
    requestId: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ providerPostId: string; externalId: string | null; url: string | null }> {
  const create = () =>
    zernioRequest<ZernioPost>(config, "posts", fetchImpl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-request-id": input.requestId },
      body: JSON.stringify({
        content: input.content,
        mediaItems: input.mediaUrls.map((item) => ({ type: item.type, url: item.url })),
        platforms: [
          {
            platform: input.platform,
            accountId: input.accountId,
            ...(input.contentType ? { platformSpecificData: { contentType: input.contentType } } : {}),
          },
        ],
        publishNow: true,
      }),
    });
  try {
    return zernioPublishResult(await create());
  } catch (error) {
    const reconciled = await reconcileZernioFailure(config, input.accountId, error, fetchImpl);
    if (reconciled) return reconciled;
    if (!isAmbiguousTransportFailure(error)) throw error;
    throw new AmbiguousPublicationError("zernio", error);
  }
}

/**
 * A delivery publisher for a target the registry routed through the provider.
 *
 * The media a provider takes is a public URL, which preparation has already
 * produced for everything it staged, so nothing here uploads bytes.
 */
export function zernioPublisher(
  config: BackendConfig,
  fetchImpl: typeof fetch,
  target: string,
  platform: "threads" | "instagram",
  accountId: string | null,
  contentType?: "story",
): (job: ClaimedPublishJob) => Promise<PublishResult> {
  return async (job) => {
    if (!config.ZERNIO_API_KEY) return { skipped: true, reason: "missing ZERNIO_API_KEY" };
    if (!accountId) return { skipped: true, reason: `${target} has no Zernio account id` };
    const media = payloadMedia(job.payload)
      .filter((item) => item.vpsUrl)
      .map((item) => ({ url: String(item.vpsUrl), type: item.type === "VIDEO" ? ("video" as const) : ("image" as const) }));
    // A Story is one visual and nothing else can stand in for it.
    if (contentType === "story" && media.length === 0) return { ok: false, error: "story_media_missing" };
    const published = await publishZernioPost(
      config,
      {
        accountId,
        platform,
        content: payloadText(job.payload).trim(),
        mediaUrls: contentType === "story" ? media.slice(0, 1) : media,
        ...(contentType ? { contentType } : {}),
        // One logical target, so a retry of the same delivery is answered with
        // the post that already exists instead of making a second one.
        requestId: `publish-target:${job.jobId}`,
      },
      fetchImpl,
    );
    return { ok: true, id: published.externalId ?? published.providerPostId, url: published.url, providerPostId: published.providerPostId };
  };
}

/** Zernio publishes at the durable publish job time. The request ID fences retries of this logical target. */
export async function publishZernioInstagramReel(
  config: BackendConfig,
  input: { accountId: string; publicUrl: string; metadata: InstagramMetadata; requestId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ providerPostId: string; externalId: string | null; url: string | null }> {
  const create = () =>
    zernioRequest<ZernioPost>(config, "posts", fetchImpl, {
      method: "POST",
      headers: {
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
  try {
    return zernioPublishResult(await create());
  } catch (error) {
    const reconciled = await reconcileZernioFailure(config, input.accountId, error, fetchImpl);
    if (reconciled) return reconciled;
    if (!isAmbiguousTransportFailure(error)) throw error;
  }
  // The same request ID makes this a safe replay: Zernio returns existingPost
  // rather than creating another publication for the logical target.
  try {
    return zernioPublishResult(await create());
  } catch (error) {
    const reconciled = await reconcileZernioFailure(config, input.accountId, error, fetchImpl);
    if (reconciled) return reconciled;
    if (isAmbiguousTransportFailure(error)) throw new AmbiguousPublicationError("zernio", error);
    throw error;
  }
}

export async function verifyZernioPost(
  config: BackendConfig,
  providerPostId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ providerPostId: string; externalId: string | null; url: string | null }> {
  const post = await zernioRequest<ZernioPost>(config, `posts/${encodeURIComponent(providerPostId)}`, fetchImpl);
  return zernioPublishResult(post, providerPostId);
}

async function reconcileZernioFailure(
  config: BackendConfig,
  accountId: string,
  error: unknown,
  fetchImpl: typeof fetch,
): Promise<{ providerPostId: string; externalId: string | null; url: string | null } | null> {
  const existingPostId = matchingDuplicatePostId(error, accountId);
  if (!existingPostId) return null;
  try {
    return await verifyZernioPost(config, existingPostId, fetchImpl);
  } catch {
    // The exact-account conflict is authoritative evidence. The lookup only
    // enriches it with the platform ID and URL, which may lag behind creation.
    return { providerPostId: existingPostId, externalId: null, url: null };
  }
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
