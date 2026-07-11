import { TARGETS } from "../botTargets.js";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { commandCenterPayload } from "./commandCenter.js";
import { pipelineStatusPayload } from "./pipeline.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ORDERED_IDS = [
  "site_en",
  "site_ru",
  "threads_en",
  "threads_ru",
  "facebook",
  "facebook_ru",
  "instagram_stories",
  "instagram_stories_ru",
  "telegram",
  "linkedin",
  "x",
  "telegram_stories",
  "bluesky",
  "mastodon",
  "devto",
  "github_en",
  "github_ru",
] as const;

type TargetInfo = { id: string; label: string; locale: string; kind: string };

const ORDERED_TARGETS: TargetInfo[] = ORDERED_IDS.map((id) => {
  const found = TARGETS.find((t) => t[0] === id);
  return found ? { id: found[0] as string, label: found[1] as string, locale: found[2] as string, kind: found[3] as string } : null;
}).filter((t) => t !== null) as TargetInfo[];

const PLATFORM_ICONS: Record<string, string> = {
  site: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
  threads: `<svg viewBox="0 0 192 192" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M141.537 88.9883C140.71 88.5919 139.87 88.2104 139.019 87.8451C137.537 60.5382 122.616 44.905 97.5619 44.745C97.4484 44.7443 97.3355 44.7443 97.222 44.7443C82.2364 44.7443 69.7731 51.1409 62.102 62.7807L75.881 72.2328C81.6116 63.5383 90.6052 61.6848 97.2286 61.6848C97.3051 61.6848 97.3819 61.6848 97.4576 61.6855C105.707 61.7381 111.932 64.1366 115.961 68.814C118.893 72.2193 120.854 76.925 121.825 82.8638C114.511 81.6207 106.601 81.2385 98.145 81.7233C74.3247 83.0954 59.0111 96.9879 60.0396 116.292C60.5615 126.084 65.4397 134.508 73.775 140.011C80.8224 144.663 89.899 146.938 99.3323 146.423C111.79 146.423 121.563 140.987 128.381 132.296C133.559 125.696 136.834 117.143 138.28 106.366C144.217 109.949 148.617 114.664 151.047 120.332C155.179 129.967 155.42 145.8 142.501 158.708C131.182 170.016 117.576 174.908 97.0135 175.059C74.2042 174.89 56.9538 167.575 45.7381 153.317C35.2355 139.966 29.8077 120.682 29.6052 96C29.8077 71.3178 35.2355 52.0336 45.7381 38.6827C56.9538 24.4249 74.2039 17.11 97.0132 16.9405C119.988 17.1113 137.539 24.4614 149.184 38.788C154.894 45.8136 159.199 54.6488 162.037 64.9503L178.184 60.6422C174.744 47.9622 169.331 37.0357 161.965 27.974C147.036 9.60668 125.202 0.195148 97.0695 0H96.9569C68.8816 0.19447 47.2921 9.6418 32.7883 28.0793C19.8819 44.4864 13.2244 67.3157 13.0007 95.9325L13 96L13.0007 96.0675C13.2244 124.684 19.8819 147.514 32.7883 163.921C47.2921 182.358 68.8816 191.806 96.9569 192H97.0695C122.03 191.827 139.624 185.292 154.118 170.811C173.081 151.866 172.51 128.119 166.26 113.541C161.776 103.087 153.227 94.5962 141.537 88.9883ZM98.4405 129.507C88.0005 130.095 77.1544 125.409 76.6196 115.372C76.2232 107.93 81.9158 99.626 99.0812 98.6368C101.047 98.5234 102.976 98.468 104.871 98.468C111.106 98.468 116.939 99.0737 122.242 100.233C120.264 124.935 108.662 128.946 98.4405 129.507Z"/></svg>`,
  facebook: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c4.56-.93 8-4.96 8-9.75z"></path></svg>`,
  telegram: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.11.02-1.93 1.23-5.46 3.62-.51.35-.98.53-1.39.51-.46-.01-1.35-.26-2.01-.48-.8-.27-1.44-.42-1.39-.89.03-.25.38-.51 1.06-.78 4.15-1.81 6.91-3 8.28-3.57 3.94-1.63 4.76-1.91 5.3-.13z"></path></svg>`,
  telegram_stories: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 2 14.9 8.3 22 9.1l-5.3 4.7 1.5 6.9L12 17.2 5.8 20.7l1.5-6.9L2 9.1l7.1-.8L12 2Z"></path></svg>`,
  instagram: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"></circle></svg>`,
  linkedin: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"></path></svg>`,
  x: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path></svg>`,
  bluesky: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 12.7c-1.1-2.1-4.1-6-6.9-7.9C2.4 3 .7 3.3.2 4.2-.3 5.1.1 8.8.5 9.9c.8 2.7 3.7 3.6 6.3 3.2-4.5.7-8.5 2.5-3.2 8.4 5.9 6.1 8.1-1.3 8.4-5.1.3 3.8 2.5 11.2 8.4 5.1 5.3-5.9 1.3-7.7-3.2-8.4 2.6.4 5.5-.5 6.3-3.2.4-1.1.8-4.8.3-5.7-.5-.9-2.2-1.2-4.9.6-2.8 1.9-5.8 5.8-6.9 7.9Z"/></svg>`,
  mastodon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M20.9 8.1c0-4.2-2.8-5.4-2.8-5.4C16.7 2 14.3 2 12 2h-.1c-2.3 0-4.7 0-6.1.7 0 0-2.8 1.2-2.8 5.4 0 1 0 2.2.1 3.4.4 4.1 3 5.1 5.7 5.5 1.4.2 2.6.2 3.2.2 1.1-.1 1.8-.3 1.8-.3l-.1-1.9s-.8.3-1.7.4c-1.7.1-3.4-.2-3.7-2.1h8.4c.1 0 2.6-.1 3-3 .1-.6.2-1.3.2-2.2Zm-3.6 2.4h-2.4V7.7c0-.6-.3-1-1-1s-1.1.4-1.1 1v2.8h-2.4V7.7c0-.6-.3-1-1-1s-1.1.4-1.1 1v2.8H5.9V7.6c0-2.2 1.4-3.4 3-3.4 1 0 1.8.4 2.3 1.1L12 6l.8-.7c.5-.7 1.3-1.1 2.3-1.1 1.6 0 3 1.2 3 3.4v2.9Z"/></svg>`,
  devto: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M7.8 7.5c-.3-.3-.7-.5-1.2-.5H4v10h2.6c.5 0 .9-.2 1.2-.5.3-.3.5-.8.5-1.3V8.8c0-.5-.2-1-.5-1.3ZM6.5 15H5.8V9h.7v6Zm6.7-6V7h-4v10h4v-2h-2.2v-2h1.7v-2h-1.7V9h2.2Zm4.7 8 2.1-10h-1.9l-1.1 6.2L15.9 7H14l2.1 10h1.8Z"/></svg>`,
  github: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.2.8-.6v-2.1c-3.3.7-4-1.4-4-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 .1.8 2.1 3.4 1.5.1-.8.4-1.4.7-1.7-2.6-.3-5.4-1.3-5.4-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2A11.5 11.5 0 0 1 12 6.8c1 0 2 .1 2.9.4 2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.4 5.9.4.3.8 1 .8 2v3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z"/></svg>`,
};

const TOOL_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`;

function platformKey(targetId: string): string {
  if (targetId.startsWith("site_")) return "site";
  if (targetId.startsWith("threads_")) return "threads";
  if (targetId.startsWith("facebook")) return "facebook";
  if (targetId.startsWith("instagram_stories")) return "instagram";
  if (targetId === "telegram_stories") return "telegram_stories";
  if (targetId.startsWith("github_")) return "github";
  return targetId;
}

function formatDayHeaderRu(date: Date): string {
  const ruMonths = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  return `${date.getUTCDate()} ${ruMonths[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function getMskDateString(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  const msk = new Date(date.getTime() + 3 * 3_600_000);
  return msk.toISOString().slice(0, 10);
}

function formatTimeMsk(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return "--:--";
  const msk = new Date(date.getTime() + 3 * 3_600_000);
  const hours = String(msk.getUTCHours()).padStart(2, "0");
  const minutes = String(msk.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatMetricValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const num = Number(value);
  if (Number.isNaN(num)) return "";
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}m`.replace(".0m", "m");
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}k`.replace(".0k", "k");
  }
  return String(num);
}

function getTargetStatus(post: any, target: string): string | null {
  const record = post.targets?.[target];
  if (record?.status && record.status !== "unknown") {
    return record.status;
  }
  if (target === "telegram" && post.telegram_url) return "published";
  if (target === "site_ru" && post.site_ru) return "published";
  if (target === "site_en" && post.site_en) return "published";
  return null;
}

function getTargetMetric(post: any, target: string, metricName: string): number {
  const status = getTargetStatus(post, target);
  if (status === "published") {
    const metric = post.metrics?.[target]?.[metricName];
    const val = metric?.value;
    if (val !== undefined && val !== null) {
      const num = Number(val);
      return Number.isNaN(num) ? 0 : num;
    }
  }
  return 0;
}

function hasTargetMetric(post: any, target: string, metricName: string): boolean {
  if (target === "site_ru" || target === "site_en") {
    if (metricName === "views") {
      const botViews = post.metrics?.[target]?.bot_views;
      if (botViews?.value !== undefined && botViews?.value !== null) return true;
    }
  }
  const metric = post.metrics?.[target]?.[metricName];
  return metric?.value !== undefined && metric?.value !== null;
}

function blueskyPublicUrlFromUri(uri: string | null, handle = "alexgetmancom.bsky.social"): string | null {
  if (!uri?.includes("/app.bsky.feed.post/")) return null;
  const parts = uri.split("/");
  const rkey = parts[parts.length - 1];
  return rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null;
}

function targetPublicUrl(target: string, externalId: string | null = null, url: string | null = null): string | null {
  if (url) {
    return url.replace("threads.net", "threads.com");
  }
  if (!externalId) return null;
  if (externalId.startsWith("http://") || externalId.startsWith("https://")) {
    return externalId;
  }
  if (target === "bluesky") {
    return blueskyPublicUrlFromUri(externalId);
  }
  if (target === "x") {
    return `https://x.com/alexgetmancom/status/${externalId}`;
  }
  if (target === "threads_ru") {
    return `https://www.threads.com/@alexgetmanru/post/${externalId}`;
  }
  if (target === "threads_en") {
    return `https://www.threads.com/@alexgetmanco/post/${externalId}`;
  }
  if (target === "linkedin") {
    return `https://www.linkedin.com/feed/update/${externalId}`;
  }
  if (target === "facebook" || target === "facebook_ru") {
    return `https://www.facebook.com/${externalId}`;
  }
  if (target === "mastodon") {
    return externalId.startsWith("https://") ? externalId : null;
  }
  if (target === "devto" || target === "github_en" || target === "github_ru") {
    return /^https?:\/\//.test(externalId) ? externalId : null;
  }
  return null;
}

function getTargetUrl(post: any, target: string): string | null {
  const record = post.targets?.[target] || {};
  const url = record.url;
  const externalId = record.external_id;
  if (url) {
    return url.replace("threads.net", "threads.com");
  }
  if (target === "telegram") {
    return post.telegram_url;
  }
  if (target === "site_ru") {
    return post.site_url;
  }
  if (target === "site_en") {
    const slugEn = post.slug_en;
    const postId = post.post_id;
    if (slugEn && postId) {
      return `/${postId}/${slugEn}/`;
    }
    return null;
  }
  if (target === "threads_ru" && externalId) {
    return `https://www.threads.com/@alexgetmanru/post/${externalId}`;
  }
  if (target === "threads_en" && externalId) {
    return `https://www.threads.com/@alexgetmanco/post/${externalId}`;
  }
  if (target === "linkedin" && externalId) {
    return `https://www.linkedin.com/feed/update/${externalId}`;
  }
  if ((target === "facebook" || target === "facebook_ru") && externalId) {
    return `https://www.facebook.com/${externalId}`;
  }
  if (target === "x" && externalId) {
    return `https://x.com/alexgetmancom/status/${externalId}`;
  }
  return targetPublicUrl(target, externalId, url);
}

function targetCell(post: any, target: string): string {
  const status = getTargetStatus(post, target);
  if (status === "published") {
    const views =
      getTargetMetric(post, target, "views") +
      (target === "site_ru" || target === "site_en" ? getTargetMetric(post, target, "bot_views") : 0);
    const likes = getTargetMetric(post, target, "likes");
    const replies = getTargetMetric(post, target, "replies");
    const reposts = getTargetMetric(post, target, "reposts");
    const url = getTargetUrl(post, target);

    const renderSubCell = (val: number, label: string, name: string) => {
      const hasMetric = hasTargetMetric(post, target, name);
      const text = !hasMetric ? "—" : val > 0 ? formatMetricValue(val) : "0";
      if (url && label === "mv") {
        return `<a class="metric-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><span class="${label}">${escapeHtml(text)}</span></a>`;
      }
      return `<span class="${label}">${escapeHtml(text)}</span>`;
    };

    return (
      renderSubCell(views, "mv", "views") +
      renderSubCell(likes, "ml", "likes") +
      renderSubCell(replies, "mr", "replies") +
      renderSubCell(reposts, "mp", "reposts")
    );
  } else if (status === "publishing" || status === "queued") {
    return '<span class="mv">~</span><span class="ml">~</span><span class="mr">~</span><span class="mp">~</span>';
  } else {
    return '<span class="mv">—</span><span class="ml">—</span><span class="mr">—</span><span class="mp">—</span>';
  }
}

function getWeekBounds(weekOffset: number): [Date, Date, string, string] {
  const nowMsk = new Date(Date.now() + 3 * 3_600_000);
  const weekday = (nowMsk.getUTCDay() + 6) % 7;

  const start = Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth(), nowMsk.getUTCDate() - weekday - weekOffset * 7, -3, 0, 0);
  const startMsk = new Date(start + 3 * 3_600_000);
  const endMsk = new Date(start + 7 * 86_400_000 - 1 + 3 * 3_600_000);

  return [startMsk, endMsk, new Date(start).toISOString(), new Date(start + 7 * 86_400_000 - 1).toISOString()];
}

function shortPipelineText(value: string | null | undefined, wordLimit = 7): string {
  if (!value) return "";
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= wordLimit) return words.join(" ");
  return `${words.slice(0, wordLimit).join(" ")}...`;
}

function formatMedia(post: any): string {
  let media: any[] = [];
  try {
    const raw = post.media_en_json || post.media_ru_json || post.media_json;
    if (raw) {
      media = JSON.parse(raw);
    }
  } catch {}
  if (!Array.isArray(media)) media = [];
  if (media.length === 0) return "text";
  const hasVideo = media.some((m: any) => m.type === "video" || m.media_type === "video");
  const mtype = hasVideo ? "vid" : "pic";
  return `${mtype} (${media.length})`;
}

function renderWeeklyChart(posts: any[], orderedTargets: any[]): string {
  const metrics = ["views", "likes", "replies"] as const;
  const colors = { views: "#58a6ff", likes: "#f778ba", replies: "#a5d6ff" };
  const labels = { views: "views", likes: "likes", replies: "replies" };

  const days: Record<string, Record<string, number>> = {};
  for (const post of posts) {
    const day = getMskDateString(post.date);
    if (!days[day]) {
      days[day] = { views: 0, likes: 0, replies: 0 };
    }
    const bucket = days[day];
    if (bucket) {
      for (const target of orderedTargets) {
        for (const metric of metrics) {
          bucket[metric] = (bucket[metric] || 0) + getTargetMetric(post, target.id, metric);
        }
      }
    }
  }

  const ordered = Object.entries(days).sort((a, b) => a[0].localeCompare(b[0]));
  if (ordered.length === 0) return "";

  const width = 980;
  const height = 138;
  const left = 42;
  const right = 18;
  const top = 14;
  const bottom = 24;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const maxByMetric = {
    views: Math.max(...ordered.map(([, b]) => b.views || 0), 1),
    likes: Math.max(...ordered.map(([, b]) => b.likes || 0), 1),
    replies: Math.max(...ordered.map(([, b]) => b.replies || 0), 1),
  };

  const point = (index: number, metric: "views" | "likes" | "replies", value: number): [number, number] => {
    const x = left + (plotW * index) / Math.max(1, ordered.length - 1);
    const y = top + plotH - (plotH * value) / maxByMetric[metric];
    return [x, y];
  };

  let grid = "";
  for (let i = 0; i < 5; i++) {
    const y = top + (plotH * i) / 4;
    grid += `<line x1="${left}" y1="${y.toFixed(1)}" x2="${width - right}" y2="${y.toFixed(1)}" class="chart-grid" />`;
  }

  const lines: string[] = [];
  const points: string[] = [];

  for (const metric of metrics) {
    const metricPoints: string[] = [];
    ordered.forEach(([day, bucket], i) => {
      const [x, y] = point(i, metric, bucket[metric] || 0);
      metricPoints.push(`${x.toFixed(1)},${y.toFixed(1)}`);

      const dayValues = metrics.map((item) => `${labels[item]}: ${formatMetricValue(bucket[item] || 0)}`).join(" · ");
      const tooltip = `${day.slice(5)} · ${dayValues}`;

      points.push(
        `<circle class="chart-point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" fill="${colors[metric]}" />` +
          `<circle class="chart-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" data-tooltip="${escapeHtml(tooltip)}" />`,
      );
    });
    lines.push(
      `<polyline class="chart-line" points="${metricPoints.join(" ")}" fill="none" stroke="${colors[metric]}" stroke-width="2.2" />`,
    );
  }

  const xLabels = ordered
    .map(([day, _], i) => {
      const x = point(i, "views", 0)[0];
      return `<text x="${x.toFixed(1)}" y="${height - 7}" text-anchor="middle">${escapeHtml(day.slice(5))}</text>`;
    })
    .join("");

  const legend = metrics
    .map((metric) => {
      const sum = ordered.reduce((acc, [, b]) => acc + (b[metric] || 0), 0);
      return `<span><i style="background:${colors[metric]}"></i>${metric}: ${formatMetricValue(sum)}</span>`;
    })
    .join("");

  return `
    <div class="metric-chart">
      <div class="metric-chart__legend">${legend}</div>
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Weekly metrics chart">${grid}${lines.join("")}${points.join("")}${xLabels}</svg>
      <div class="chart-tooltip" id="chart-tooltip" hidden></div>
    </div>
  `;
}

function renderPipelineSection(weekOffset: number, data: any): string {
  const [startOfWeek, endOfWeek] = getWeekBounds(weekOffset);
  const weekStartStr = formatDayHeaderRu(startOfWeek);
  const weekEndStr = formatDayHeaderRu(endOfWeek);

  const nextBtn =
    weekOffset > 0
      ? `<a class="pag-btn" href="/command-center?tab=pipeline&week_offset=${weekOffset - 1}">Следующая неделя &rarr;</a>`
      : '<span class="pag-btn disabled">Следующая неделя &rarr;</span>';
  const currentBtn = weekOffset > 0 ? `<a class="pag-btn" href="/command-center?tab=pipeline&week_offset=0">Текущая неделя</a>` : "";
  const prevBtn = `<a class="pag-btn" href="/command-center?tab=pipeline&week_offset=${weekOffset + 1}">&larr; Предыдущая неделя</a>`;

  const paginationBar = `
    <div class="pagination-bar">
      ${prevBtn}
      ${currentBtn}
      <span class="pag-current">${weekStartStr} &ndash; ${weekEndStr}</span>
      ${nextBtn}
    </div>
  `;

  const row1Headers: string[] = [];
  const row2Headers: string[] = [];
  let i = 0;
  const n = ORDERED_TARGETS.length;
  while (i < n) {
    const target = ORDERED_TARGETS[i];
    if (!target) {
      i++;
      continue;
    }
    const pkey = platformKey(target.id);
    const icon = PLATFORM_ICONS[pkey] || "";

    const nextTarget = i + 1 < n ? ORDERED_TARGETS[i + 1] : null;
    if (nextTarget && platformKey(nextTarget.id) === pkey) {
      const label =
        {
          x: "X (Twitter)",
          github: "GitHub",
          devto: "dev.to",
        }[pkey] || pkey.charAt(0).toUpperCase() + pkey.slice(1);
      row1Headers.push(`<th colspan="2" class="text-center" title="${label}">${icon}</th>`);
      row2Headers.push(`<th class="text-center">${target.locale.toUpperCase()}</th>`);
      row2Headers.push(`<th class="text-center">${nextTarget.locale.toUpperCase()}</th>`);
      i += 2;
    } else {
      const label = target.label;
      row1Headers.push(`<th class="text-center" title="${label}">${icon}</th>`);
      row2Headers.push("<th></th>");
      i += 1;
    }
  }

  const targetRow1 = row1Headers.join("");
  const targetRow2 = row2Headers.join("");
  const totalCols = 6 + ORDERED_TARGETS.length + 1;

  // Group posts by day (MSK)
  const daysDict: Record<string, { dayTitle: string; posts: any[] }> = {};
  for (const post of data?.posts || []) {
    const date = new Date(post.date);
    if (Number.isNaN(date.getTime())) continue;
    const msk = new Date(date.getTime() + 3 * 3_600_000);
    const dayStr = msk.toISOString().slice(0, 10);
    if (!daysDict[dayStr]) {
      daysDict[dayStr] = { dayTitle: formatDayHeaderRu(msk), posts: [] };
    }
    daysDict[dayStr].posts.push(post);
  }

  const metricsList = ["views", "likes", "replies", "reposts"] as const;
  type MetricName = (typeof metricsList)[number];

  const renderMetricSpan = (val: number, className: string) => {
    const text = val > 0 ? formatMetricValue(val) : className === "mv" ? "0" : "—";
    return `<span class="${className}">${escapeHtml(text)}</span>`;
  };

  const renderedRows: string[] = [];
  const sortedDays = Object.entries(daysDict).sort((a, b) => b[0].localeCompare(a[0]));

  for (const [, dayInfo] of sortedDays) {
    const dayTitle = dayInfo.dayTitle;
    const dayPosts = dayInfo.posts;

    const dayM: Record<MetricName, Record<string, number>> = {
      views: {},
      likes: {},
      replies: {},
      reposts: {},
    };
    const dayTotals: Record<MetricName, number> = {
      views: 0,
      likes: 0,
      replies: 0,
      reposts: 0,
    };

    for (const target of ORDERED_TARGETS) {
      dayM.views[target.id] = 0;
      dayM.likes[target.id] = 0;
      dayM.replies[target.id] = 0;
      dayM.reposts[target.id] = 0;
    }

    for (const post of dayPosts) {
      for (const target of ORDERED_TARGETS) {
        for (const m of metricsList) {
          const v = getTargetMetric(post, target.id, m);
          dayM[m][target.id] = (dayM[m][target.id] || 0) + v;
          dayTotals[m] += v;
        }
      }
    }

    renderedRows.push(
      `<tr class="day-separator">` + `<td colspan="${totalCols}"><span class="day-label">${dayTitle}</span></td>` + `</tr>`,
    );

    for (const post of dayPosts) {
      const timeStr = formatTimeMsk(post.date);
      const displayId = escapeHtml(post.post_id || post.message_id);
      const postLink = post.site_url ? `<a href="${escapeHtml(post.site_url)}">${displayId}</a>` : displayId;

      const ptotals = {
        views: ORDERED_TARGETS.reduce((sum, t) => sum + getTargetMetric(post, t.id, "views"), 0),
        likes: ORDERED_TARGETS.reduce((sum, t) => sum + getTargetMetric(post, t.id, "likes"), 0),
        replies: ORDERED_TARGETS.reduce((sum, t) => sum + getTargetMetric(post, t.id, "replies"), 0),
        reposts: ORDERED_TARGETS.reduce((sum, t) => sum + getTargetMetric(post, t.id, "reposts"), 0),
      };

      const sigma =
        renderMetricSpan(ptotals.views, "mv") +
        renderMetricSpan(ptotals.likes, "ml") +
        renderMetricSpan(ptotals.replies, "mr") +
        renderMetricSpan(ptotals.reposts, "mp");

      const ruText = post.text_ru || "";
      const enText = post.text_en || "";

      const postRow =
        `<tr>` +
        `<td>${postLink}</td>` +
        `<td class="nowrap date-col text-center">${timeStr}</td>` +
        `<td class="post-text" title="${escapeHtml(ruText)}">${escapeHtml(shortPipelineText(ruText, 7))}</td>` +
        `<td class="post-text" title="${escapeHtml(enText)}">${escapeHtml(shortPipelineText(enText, 7))}</td>` +
        `<td>${escapeHtml(formatMedia(post))}</td>` +
        `<td class="text-center nowrap font-bold">${sigma}</td>` +
        ORDERED_TARGETS.map((target) => `<td class="text-center">${targetCell(post, target.id)}</td>`).join("") +
        `<td class="text-center"><a href="/command-center?tab=repair&ref=${escapeHtml(post.post_id || post.message_id || "")}&message_id=${escapeHtml(post.telegram_message_id || "")}" title="Repair">${TOOL_ICON}</a></td>` +
        `</tr>`;
      renderedRows.push(postRow);
    }

    const daySigma =
      renderMetricSpan(dayTotals.views, "mv") +
      renderMetricSpan(dayTotals.likes, "ml") +
      renderMetricSpan(dayTotals.replies, "mr") +
      renderMetricSpan(dayTotals.reposts, "mp");

    const dayCols = ['<td colspan="4"></td>', "<td></td>", `<td class="text-center font-bold">${daySigma}</td>`];
    for (const target of ORDERED_TARGETS) {
      const cell =
        renderMetricSpan(dayM.views[target.id] || 0, "mv") +
        renderMetricSpan(dayM.likes[target.id] || 0, "ml") +
        renderMetricSpan(dayM.replies[target.id] || 0, "mr") +
        renderMetricSpan(dayM.reposts[target.id] || 0, "mp");
      dayCols.push(`<td class="text-center font-bold">${cell}</td>`);
    }
    dayCols.push("<td></td>");
    renderedRows.push(`<tr class="day-header">${dayCols.join("")}</tr>`);
  }

  const weekM: Record<MetricName, Record<string, number>> = {
    views: {},
    likes: {},
    replies: {},
    reposts: {},
  };
  const weekTotals: Record<MetricName, number> = {
    views: 0,
    likes: 0,
    replies: 0,
    reposts: 0,
  };
  for (const target of ORDERED_TARGETS) {
    weekM.views[target.id] = 0;
    weekM.likes[target.id] = 0;
    weekM.replies[target.id] = 0;
    weekM.reposts[target.id] = 0;
  }
  for (const post of data?.posts || []) {
    for (const target of ORDERED_TARGETS) {
      for (const m of metricsList) {
        const v = getTargetMetric(post, target.id, m);
        weekM[m][target.id] = (weekM[m][target.id] || 0) + v;
        weekTotals[m] += v;
      }
    }
  }
  const weekSigma =
    renderMetricSpan(weekTotals.views, "mv") +
    renderMetricSpan(weekTotals.likes, "ml") +
    renderMetricSpan(weekTotals.replies, "mr") +
    renderMetricSpan(weekTotals.reposts, "mp");

  const weekCols = ['<td colspan="4"><b>Итого за неделю</b></td>', "<td></td>", `<td class="text-center font-bold">${weekSigma}</td>`];
  for (const target of ORDERED_TARGETS) {
    const cell =
      renderMetricSpan(weekM.views[target.id] || 0, "mv") +
      renderMetricSpan(weekM.likes[target.id] || 0, "ml") +
      renderMetricSpan(weekM.replies[target.id] || 0, "mr") +
      renderMetricSpan(weekM.reposts[target.id] || 0, "mp");
    weekCols.push(`<td class="text-center font-bold">${cell}</td>`);
  }
  weekCols.push("<td></td>");
  renderedRows.push(`<tr class="week-total">${weekCols.join("")}</tr>`);

  const rows = renderedRows.join("\n");
  const processedCount = data?.social_worker?.processed_count ?? 0;
  const lastUpdateId = data?.social_worker?.last_update_id ?? "n/a";
  const updatedTime = data?.updated_at ?? new Date().toISOString();

  return `
    <section style="margin-top: 0;">
      ${paginationBar}
      <div class="metric-dashboard">
        <div class="metric-toggle metric-toggle--vertical" id="metric-toggle">
          <button class="mt-btn mt-active" data-m="mv" onclick="setMetric('mv')">👁 Views</button>
          <button class="mt-btn" data-m="ml" onclick="setMetric('ml')">❤️ Likes</button>
          <button class="mt-btn" data-m="mr" onclick="setMetric('mr')">💬 Replies</button>
        </div>
        ${renderWeeklyChart(data?.posts || [], ORDERED_TARGETS)}
      </div>
      <div class="table-wrap">
      <table id="pipeline-table" class="show-mv">
        <thead>
          <tr>
            <th colspan="6"></th>
            ${targetRow1}
            <th></th>
          </tr>
          <tr>
            <th>Post</th>
            <th class="date-col">Date</th>
            <th>RU</th>
            <th>EN</th>
            <th>Media</th>
            <th class="text-center" title="Общие просмотры">&Sigma;</th>
            ${targetRow2}
            <th class="text-center" title="Repair">${TOOL_ICON}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
      <p class="note">
        Feed: ${data?.feed?.items ?? 0} | 
        Processed: ${processedCount} | 
        Last update: ${escapeHtml(lastUpdateId)} | 
        JSON: <a href="/api/pipeline-status?week_offset=${weekOffset}">/api/pipeline-status</a> | 
        Updated: ${escapeHtml(updatedTime)}
      </p>
    </section>
  `;
}

function renderRepairSection(ref: string, messageId: string): string {
  const options = ORDERED_TARGETS.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join("\n");
  return `
    <section>
      <h2>Repair</h2>
      <form method="post" action="/api/command-center/action">
        <input name="token" type="hidden" value="">
        <select name="action">
          <option value="retry">Retry / republish</option>
          <option value="edit_en">Edit EN</option>
          <option value="replace_en_media">Replace EN media</option>
          <option value="use_ru_media_for_en">Use RU media for EN</option>
        </select>
        <input name="ref" placeholder="post id / post:key / msg:id" value="${escapeHtml(ref)}">
        <input name="message_id" placeholder="telegram message id (edit/media only)" value="${escapeHtml(messageId)}">
        <select name="target">
          <option value="">all targets</option>
          ${options}
        </select>
        <textarea name="text_en" placeholder="EN text for edit_en"></textarea>
        <textarea name="media_en_json" placeholder='EN media JSON, example: [{"type":"photo","file_id":"..."}]'></textarea>
        <button type="submit">Apply</button>
      </form>
    </section>
  `;
}

function renderQueueSection(ops: any): string {
  const draftsList =
    (ops.drafts || [])
      .map((row: any) => {
        const ruText = row.text_ru ?? "";
        return `<tr><td>${Number(row.id)}</td><td>${escapeHtml(row.status)}</td><td class="wide">${escapeHtml(shortPipelineText(ruText, 20))}</td><td>${escapeHtml(row.scheduled_at ?? "")}</td><td>${escapeHtml(row.scheduled_en_at ?? "")}</td><td>${escapeHtml(row.channel_message_id ?? "")}</td><td>${escapeHtml(row.updated_at)}</td></tr>`;
      })
      .join("\n") || "<tr><td colspan='7'>empty</td></tr>";

  const queueList =
    (ops.jobs || [])
      .map((row: any) => {
        return (
          `<tr>` +
          `<td>${escapeHtml(row.job_id ?? row.jobId ?? "")}</td>` +
          `<td>${escapeHtml(row.post_id ?? row.postId ?? "")}</td>` +
          `<td>${escapeHtml(row.message_id ?? row.messageId ?? "")}</td>` +
          `<td>${escapeHtml(row.target)}</td>` +
          `<td>${escapeHtml(row.status)}</td>` +
          `<td>${Number(row.attempt_count ?? row.attemptCount ?? 0)}</td>` +
          `<td>${escapeHtml(row.publish_at ?? row.publishAt ?? "")}</td>` +
          `<td>${escapeHtml(row.next_attempt_at ?? row.nextAttemptAt ?? "")}</td>` +
          `<td class="wide">${escapeHtml(row.last_error ?? row.lastError ?? "")}</td>` +
          `<td>${escapeHtml(row.updated_at ?? row.updatedAt ?? "")}</td>` +
          `</tr>`
        );
      })
      .join("\n") || "<tr><td colspan='9'>empty</td></tr>";

  return `
    <section><h2>Drafts</h2><table><thead><tr><th>ID</th><th>Status</th><th>RU</th><th>RU slot</th><th>EN slot</th><th>Message</th><th>Updated</th></tr></thead><tbody>${draftsList}</tbody></table></section>
    <section><h2>Queue</h2><table><thead><tr><th>Job</th><th>Post</th><th>Telegram msg</th><th>Target</th><th>Status</th><th>Attempts</th><th>Publish at</th><th>Retry at</th><th>Error</th><th>Updated</th></tr></thead><tbody>${queueList}</tbody></table></section>
  `;
}

function renderCredentialsSection(ops: any): string {
  const rows =
    (ops.credentials || [])
      .map((row: any) => {
        return `<tr><td>${escapeHtml(row.target ?? row.name ?? row.credential)}</td><td>${escapeHtml(row.status ?? (row.ok ? "ok" : "failed"))}</td><td>${escapeHtml(row.missing_env_json ?? row.error ?? "")}</td><td>${escapeHtml(row.last_checked_at ?? row.checked_at ?? row.updated_at ?? "")}</td></tr>`;
      })
      .join("\n") || "<tr><td colspan='4'>empty</td></tr>";
  return `<section><h2>Credentials</h2><table><thead><tr><th>Target</th><th>Status</th><th>Missing</th><th>Checked</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderDiagnosticsSection(ops: any): string {
  const errors =
    (ops.pipeline?.metrics?.recent || [])
      .filter((row: any) => row.error || row.status === "failed")
      .slice(0, 30)
      .map((row: any) => {
        return `<tr><td>${escapeHtml(row.message_id ?? row.messageId ?? "")}</td><td>${escapeHtml(row.target)}</td><td>${escapeHtml(row.status ?? "failed")}</td><td class="wide">${escapeHtml(row.error)}</td></tr>`;
      })
      .join("\n") || "<tr><td colspan='4'>empty</td></tr>";

  const lifecycle =
    (ops.lifecycle || [])
      .slice(0, 30)
      .map((row: any) => {
        return `<tr><td>${escapeHtml(row.post_key ?? row.post_id ?? "")}</td><td>${escapeHtml(row.state ?? row.status ?? "")}</td><td>${escapeHtml(row.reason ?? "")}</td><td>${escapeHtml(row.updated_at)}</td></tr>`;
      })
      .join("\n") || "<tr><td colspan='4'>empty</td></tr>";

  return `
    <section><h2>Errors</h2><table><thead><tr><th>Message</th><th>Target</th><th>Status</th><th>Error</th></tr></thead><tbody>${errors}</tbody></table></section>
    <section><h2>Lifecycle</h2><table><thead><tr><th>Message</th><th>State</th><th>Reason</th><th>Updated</th></tr></thead><tbody>${lifecycle}</tbody></table></section>
    <section><h2>Advanced JSON</h2><p><a href="/api/ops-dashboard">/api/ops-dashboard</a> includes analytics, media assets, capabilities and content memory for agents.</p></section>
  `;
}

export function renderDashboard(config: BackendConfig, backendDb: BackendDb, requestedTab: string | undefined, weekOffset: number): string {
  const TABS = ["pipeline", "repair", "queue", "credentials", "diagnostics"] as const;
  type DashboardTab = (typeof TABS)[number];
  const tab: DashboardTab = TABS.includes(requestedTab as DashboardTab) ? (requestedTab as DashboardTab) : "pipeline";

  const ops = commandCenterPayload(config, backendDb);
  const data = tab === "pipeline" ? pipelineStatusPayload(config, backendDb, weekOffset) : null;

  let body = "";
  if (tab === "repair") {
    body = renderRepairSection("", "");
  } else if (tab === "queue") {
    body = renderQueueSection(ops);
  } else if (tab === "credentials") {
    body = renderCredentialsSection(ops);
  } else if (tab === "diagnostics") {
    body = renderDiagnosticsSection(ops);
  } else {
    body = renderPipelineSection(weekOffset, data);
  }

  const navLinks = TABS.map((item) => {
    const label = {
      pipeline: "Pipeline",
      repair: "Repair",
      queue: "Queue",
      credentials: "Credentials",
      diagnostics: "Diagnostics",
    }[item];
    return `<a class="${item === tab ? "active" : ""}" href="/command-center?tab=${item}&week_offset=${weekOffset}">${label}</a>`;
  }).join("");

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Command Center</title>
  <style>
    body { margin:0; padding:24px; background:#0d1117; color:#c9d1d9; font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { max-width:1480px; margin:0 auto; }
    h1,h2 { color:#fff; }
    nav { display:flex; gap:8px; flex-wrap:wrap; margin:18px 0 0; padding-top:12px; border-top:1px solid #30363d; }
    nav a { color:#c9d1d9; border:1px solid #30363d; padding:6px 9px; border-radius:6px; text-decoration:none; font-size:13px; }
    nav a.active { color:#fff; border-color:#58a6ff; background:#13233a; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:12px 0 18px; }
    .stat, section { border:1px solid #30363d; background:#161b22; border-radius:8px; }
    .stat { padding:14px; } .stat span { display:block; color:#58a6ff; font-size:24px; font-weight:700; margin-top:6px; }
    section { margin-top:0; padding:10px; overflow-x:auto; }
    .table-wrap { overflow-x:auto; }
    table { width:100%; min-width:980px; border-collapse:collapse; }
    th,td { padding:6px 10px; border-bottom:1px solid #30363d; text-align:left; vertical-align:top; }
    th { color:#8b949e; white-space:nowrap; }
    a { color:#58a6ff; } .wide { max-width:520px; overflow-wrap:anywhere; }
    .post-text { min-width:160px; max-width:280px; overflow-wrap:anywhere; }
    .nowrap { white-space:nowrap; } .note { color:#8b949e; }
    .date-col { width:60px; }
    .text-center { text-align:center; }

    th svg { color:#8b949e; transition:color 0.2s; }
    th:hover svg { color:#fff; }
    form { display:flex; flex-wrap:wrap; gap:8px; }
    input,select,textarea,button { background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:6px; padding:8px; }
    textarea { min-width:min(720px,100%); min-height:70px; }
    
    .day-header td { background: #21262d; color: #fff; font-weight: 600; padding: 8px 12px; border-bottom: 1px solid #30363d; }
    .week-total td { background: #1a3a5c; color: #7dd3fc; font-weight: 700; padding: 10px 12px; border-top: 2px solid #3b82f6; border-bottom: 2px solid #3b82f6; }
    .day-separator td { padding: 4px 12px 2px; background: transparent; border-top: 1px solid #30363d; border-bottom: 0; }
    .day-label { font-size: 11px; font-weight: 700; color: #8b949e; text-transform: uppercase; letter-spacing: 0.06em; }
    
    .mv,.ml,.mr,.mp { display:none; }
    #pipeline-table.show-mv .mv { display:inline; }
    #pipeline-table.show-ml .ml { display:inline; }
    #pipeline-table.show-mr .mr { display:inline; }
    #pipeline-table.show-mp .mp { display:inline; }
    
    .metric-dashboard { display:grid; grid-template-columns:112px minmax(0,1fr); gap:8px; align-items:stretch; margin:0 0 8px; }
    .metric-toggle { display:flex; gap:6px; margin:0; }
    .metric-toggle--vertical { flex-direction:column; justify-content:center; }
    .mt-btn { background:#161b22; color:#8b949e; border:1px solid #30363d; border-radius:18px; padding:5px 10px; font-size:13px; cursor:pointer; transition:all 0.15s; text-align:left; }
    .mt-btn:hover { background:#21262d; color:#c9d1d9; }
    .mt-btn.mt-active { background:#1f6feb; color:#fff; border-color:#1f6feb; font-weight:600; }
    .day-stat td { border-top: 1px solid #30363d; border-bottom: 2px double #30363d; background: #161b22; color: #c9d1d9; }
    .day-stat-label { text-align: right; color: #8b949e; font-weight: normal; }
    .font-bold { font-weight: bold; }
    .pagination-bar { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 0 0 8px; padding: 5px 8px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
    .pag-btn { color: #58a6ff; border: 1px solid #30363d; padding: 4px 9px; border-radius: 6px; text-decoration: none; font-size: 12px; background: #0d1117; transition: background 0.2s, border-color 0.2s; }
    .pag-btn:hover:not(.disabled) { background: #21262d; border-color: #8b949e; }
    .pag-btn.disabled { color: #8b949e; border-color: #21262d; background: #0d1117; cursor: not-allowed; }
    .pag-current { font-weight: 700; color: #fff; font-size: 14px; }
    .metric-chart { position:relative; margin:0; padding:7px 10px 4px; background:#0d1117; border:1px solid #30363d; border-radius:8px; }
    .metric-chart svg { width:100%; height:166px; display:block; }
    .metric-chart text { fill:#8b949e; font-size:11px; }
    .chart-grid { stroke:#30363d; stroke-width:1; opacity:.75; }
    .chart-line { vector-effect: non-scaling-stroke; }
    .metric-chart__legend { display:flex; flex-wrap:wrap; gap:11px; margin:0 0 -1px; color:#c9d1d9; font-size:12px; }
    .metric-chart__legend span { display:inline-flex; align-items:center; gap:5px; }
    .metric-chart__legend i { display:inline-block; width:9px; height:9px; border-radius:50%; }
    .metric-chart__hint { color:#8b949e; font-size:11px; margin:0 0 2px; }
    .chart-point { vector-effect: non-scaling-stroke; stroke:#0d1117; stroke-width:1.4; }
    .chart-hit { fill:transparent; cursor:crosshair; }
    .chart-tooltip { position:fixed; z-index:50; pointer-events:none; max-width:280px; padding:7px 9px; background:#161b22; border:1px solid #58a6ff; border-radius:6px; color:#f0f6fc; font-size:12px; box-shadow:0 8px 24px rgba(0,0,0,.35); white-space:nowrap; }
    
    .metric-link { text-decoration: none; }
    
    @media (max-width: 760px) {
      body { padding:10px; }
      main { max-width:none; }
      .metric-dashboard { grid-template-columns:1fr; }
      .metric-toggle--vertical { flex-direction:row; justify-content:flex-start; }
      .pagination-bar { align-items:stretch; flex-wrap:wrap; justify-content:center; }
      .pag-current { flex:1 1 100%; text-align:center; }
    }
  </style>
</head>
<body>
<main>
  ${body}
  <nav>${navLinks}</nav>
</main>
<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  document.querySelectorAll('input[name="token"]').forEach((input) => input.value = token);
  function setMetric(m) {
    const tbl = document.getElementById('pipeline-table');
    tbl.className = tbl.className.replace(/show-m\\w/g, '') + ' show-' + m;
    document.querySelectorAll('.mt-btn').forEach(b => b.classList.toggle('mt-active', b.dataset.m === m));
  }
  const chartTooltip = document.getElementById('chart-tooltip');
  document.querySelectorAll('.chart-hit').forEach((point) => {
    point.addEventListener('mouseenter', () => {
      if (!chartTooltip) return;
      chartTooltip.textContent = point.dataset.tooltip || '';
      chartTooltip.hidden = false;
    });
    point.addEventListener('mousemove', (event) => {
      if (!chartTooltip) return;
      chartTooltip.style.left = \`\${event.clientX + 12}px\`;
      chartTooltip.style.top = \`\${event.clientY + 12}px\`;
    });
    point.addEventListener('mouseleave', () => {
      if (chartTooltip) chartTooltip.hidden = true;
    });
  });
</script>
</body>
</html>`;
}
