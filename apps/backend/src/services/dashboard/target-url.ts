import type { PipelinePost } from "./types.js";

function blueskyPublicUrlFromUri(uri: string | null, handle = "alexgetmancom.bsky.social"): string | null {
  if (!uri?.includes("/app.bsky.feed.post/")) return null;
  const rkey = uri.split("/").at(-1);
  return rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null;
}

function targetPublicUrl(target: string, externalId: string | null = null, url: string | null = null): string | null {
  if (url) return url.replace("threads.net", "threads.com");
  if (!externalId) return null;
  if (externalId.startsWith("http://") || externalId.startsWith("https://")) return externalId;
  if (target === "bluesky") return blueskyPublicUrlFromUri(externalId);
  if (target === "x") return `https://x.com/alexgetmancom/status/${externalId}`;
  if (target === "threads_ru") return `https://www.threads.com/@alexgetmanru/post/${externalId}`;
  if (target === "threads_en") return `https://www.threads.com/@alexgetmanco/post/${externalId}`;
  if (target === "linkedin") return `https://www.linkedin.com/feed/update/${externalId}`;
  if (target === "facebook" || target === "facebook_ru") return `https://www.facebook.com/${externalId}`;
  if (target === "mastodon") return externalId.startsWith("https://") ? externalId : null;
  if (target === "devto" || target === "github_en" || target === "github_ru") return /^https?:\/\//.test(externalId) ? externalId : null;
  return null;
}

export function getTargetUrl(post: PipelinePost, target: string): string | null {
  const record = post.targets?.[target];
  const url = typeof record?.url === "string" ? record.url : null;
  const externalId = typeof record?.external_id === "string" ? record.external_id : null;
  if (target === "telegram") return post.telegram_url ?? targetPublicUrl(target, externalId, url);
  if (target === "site_ru") return post.site_url ?? targetPublicUrl(target, externalId, url);
  if (target === "site_en") {
    const slugEn = post.slug_en;
    const postId = post.post_id;
    return slugEn && postId ? `/${postId}/${slugEn}/` : targetPublicUrl(target, externalId, url);
  }
  return targetPublicUrl(target, externalId, url);
}
