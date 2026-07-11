import type { BackendConfig } from "../config.js";
import { requestJson, requestText } from "../social/http.js";
import { createChannelStoryClient } from "../social/telegramSession.js";
import { oauthAuthorization } from "../social/x.js";
import type { MetricTask } from "./schedule.js";

export type MetricResult = { metrics: Record<string, number>; source: string; raw: unknown; url?: string };
export type MetricCollector = (task: MetricTask) => Promise<MetricResult>;

export function createMetricCollectors(config: BackendConfig, fetchImpl: typeof fetch = fetch): Record<string, MetricCollector> {
  const threads = (task: MetricTask) => collectThreads(task, config, fetchImpl);
  const facebook = (task: MetricTask) => collectFacebook(task, config, fetchImpl);
  const instagram = (task: MetricTask) => collectInstagramStory(task, config, fetchImpl);
  return {
    telegram: (task) => collectTelegram(task, config, fetchImpl),
    threads: threads,
    threads_ru: threads,
    threads_en: threads,
    facebook: facebook,
    facebook_ru: facebook,
    devto: (task) => collectDevto(task, config, fetchImpl),
    bluesky: (task) => collectBluesky(task, fetchImpl),
    mastodon: (task) => collectMastodon(task, config, fetchImpl),
    github: (task) => collectGitHub(task, config, fetchImpl),
    github_en: (task) => collectGitHub(task, config, fetchImpl),
    github_ru: (task) => collectGitHub(task, config, fetchImpl),
    instagram_story: instagram,
    instagram_stories: instagram,
    instagram_stories_ru: instagram,
    telegram_story: (task) => collectTelegramStory(task, config),
    telegram_stories: (task) => collectTelegramStory(task, config),
    x: (task) => collectX(task, config, fetchImpl),
    twitter: (task) => collectX(task, config, fetchImpl),
    linkedin: (task) => collectLinkedIn(task, config, fetchImpl),
  };
}

async function collectTelegram(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const channel = config.CHANNEL_USERNAME.replace(/^@/, "");
  const html = await requestText(fetchImpl, `https://t.me/s/${channel}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; alexgetman-backend/1.0)" },
    signal: AbortSignal.timeout(config.TELEGRAM_METRICS_TIMEOUT_SECONDS * 1000),
  });
  const escaped = escapeRegExp(`${channel}/${task.messageId}`);
  const section = html.match(
    new RegExp(`data-post=["']${escaped}["'][\\s\\S]*?(?=data-post=["']${escapeRegExp(channel)}\\/|<\\/section>|$)`),
  )?.[0];
  if (!section) throw new Error("telegram_post_not_found");
  const views = parseCompactCount(section.match(/tgme_widget_message_views[^>]*>([^<]+)</)?.[1]);
  const reactions = [...section.matchAll(/class=["']tgme_reaction["'][^>]*>[\s\S]*?<\/i>([^<]+)/g)]
    .map((match) => parseCompactCount(match[1]) ?? 0)
    .reduce((sum, value) => sum + value, 0);
  if (views == null) throw new Error("telegram_views_not_found");
  return { metrics: { views, likes: reactions }, source: "t_me_public", raw: { message_id: task.messageId } };
}

async function collectThreads(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const token =
    task.target === "threads_en" ? (config.THREADS_EN_ACCESS_TOKEN ?? config.THREADS_ACCESS_TOKEN) : config.THREADS_ACCESS_TOKEN;
  if (!token || task.externalIds.length === 0) throw new Error("missing_threads_token_or_id");
  const totals: Record<string, number> = {};
  const parts: unknown[] = [];
  for (const id of task.externalIds) {
    const url = new URL(`https://graph.threads.net/v1.0/${id}/insights`);
    url.searchParams.set("metric", config.THREADS_METRICS);
    url.searchParams.set("access_token", token);
    const result = await requestJson<{ data?: Array<{ name?: string; values?: Array<{ value?: number }> }> }>(fetchImpl, url.toString());
    const metrics: Record<string, number> = {};
    for (const item of result.data ?? []) {
      if (item.name) metrics[item.name] = Number(item.values?.[0]?.value ?? 0);
    }
    for (const [name, value] of Object.entries(metrics)) totals[name] = (totals[name] ?? 0) + value;
    parts.push({ id, metrics });
  }
  let permalink = task.url ?? undefined;
  if (!permalink && task.externalId) {
    const url = new URL(`https://graph.threads.net/v1.0/${task.externalId}`);
    url.searchParams.set("fields", "permalink");
    url.searchParams.set("access_token", token);
    permalink = (await requestJson<{ permalink?: string }>(fetchImpl, url.toString())).permalink?.replace("threads.net", "threads.com");
  }
  return { metrics: totals, source: "threads_insights_api", raw: { parts }, ...(permalink ? { url: permalink } : {}) };
}

async function collectFacebook(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const token = task.target === "facebook_ru" ? config.FACEBOOK_RU_PAGE_ACCESS_TOKEN : config.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!token || !task.externalId) throw new Error("missing_facebook_token_or_id");
  const base = `https://graph.facebook.com/${config.FACEBOOK_GRAPH_API_VERSION}/${task.externalId}`;
  const metrics: Record<string, number> = {};
  const errors: string[] = [];
  try {
    const url = graphUrl(`${base}/insights`, token, { metric: "post_total_media_view_unique", period: "lifetime" });
    const data = await requestJson<{ data?: Array<{ name?: string; values?: Array<{ value?: number }> }> }>(fetchImpl, url);
    const item = data.data?.find((value) => value.name === "post_total_media_view_unique");
    if (item) metrics.views = Number(item.values?.[0]?.value ?? 0);
  } catch (error) {
    errors.push(`post insights: ${errorMessage(error)}`);
  }
  try {
    const data = await requestJson<{
      reactions?: { summary?: { total_count?: number } };
      comments?: { summary?: { total_count?: number } };
      shares?: { count?: number };
    }>(fetchImpl, graphUrl(base, token, { fields: "reactions.summary(total_count),comments.summary(total_count),shares" }));
    metrics.likes = Number(data.reactions?.summary?.total_count ?? 0);
    metrics.replies = Number(data.comments?.summary?.total_count ?? 0);
    metrics.reposts = Number(data.shares?.count ?? 0);
  } catch (error) {
    errors.push(`post fields: ${errorMessage(error)}`);
    for (const [edge, name] of [
      ["likes", "likes"],
      ["comments", "replies"],
    ] as const) {
      try {
        const data = await requestJson<{ summary?: { total_count?: number } }>(
          fetchImpl,
          graphUrl(`${base}/${edge}`, token, { summary: "total_count", limit: "0" }),
        );
        metrics[name] = Number(data.summary?.total_count ?? 0);
      } catch (edgeError) {
        errors.push(`${edge}: ${errorMessage(edgeError)}`);
      }
    }
  }
  if (metrics.views == null) {
    for (const metric of ["fb_reels_total_plays", "total_video_views"]) {
      try {
        const data = await requestJson<{ data?: Array<{ name?: string; values?: Array<{ value?: number }> }> }>(
          fetchImpl,
          graphUrl(`${base}/video_insights`, token, { metric, ...(metric === "total_video_views" ? { period: "lifetime" } : {}) }),
        );
        const item = data.data?.find((value) => value.name === metric);
        if (item) metrics.views = Number(item.values?.at(-1)?.value ?? 0);
      } catch (error) {
        errors.push(`${metric}: ${errorMessage(error)}`);
      }
      if (metrics.views != null) break;
    }
  }
  if (Object.keys(metrics).length === 0) throw new Error(`Facebook metrics failed: ${errors.join("; ")}`);
  return { metrics, source: "facebook_insights_api", raw: { external_id: task.externalId, errors } };
}

async function collectDevto(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const match = (task.url ?? task.externalId ?? "").match(/dev\.to\/([^/]+)\/([^/?#]+)/);
  if (!match) throw new Error("missing_devto_article_path");
  const [, username, slug] = match;
  let article: DevtoMetrics | undefined;
  let source = "devto_api_public";
  if (config.DEVTO_API_KEY) {
    for (let page = 1; page <= 5 && !article; page += 1) {
      const data = await requestJson<DevtoMetrics[]>(fetchImpl, `https://dev.to/api/articles/me?per_page=100&page=${page}`, {
        headers: { "api-key": config.DEVTO_API_KEY, "User-Agent": "alexgetman-backend/1.0" },
      });
      article = data.find((item) => item.slug === slug || item.url?.replace(/\/$/, "") === task.url?.replace(/\/$/, ""));
      if (data.length === 0) break;
    }
    if (article) source = "devto_api_authenticated";
  }
  article ??= await requestJson<DevtoMetrics>(fetchImpl, `https://dev.to/api/articles/${username}/${slug}`, {
    headers: { "User-Agent": "alexgetman-backend/1.0" },
  });
  return {
    metrics: {
      views: Number(article.page_views_count ?? 0),
      likes: Number(article.public_reactions_count ?? article.positive_reactions_count ?? 0),
      replies: Number(article.comments_count ?? 0),
    },
    source,
    raw: { api_id: article.id, slug },
  };
}

type DevtoMetrics = {
  id?: number;
  slug?: string;
  url?: string;
  page_views_count?: number;
  public_reactions_count?: number;
  positive_reactions_count?: number;
  comments_count?: number;
};

async function collectBluesky(task: MetricTask, fetchImpl: typeof fetch): Promise<MetricResult> {
  const ids = task.externalIds.filter((id) => id.startsWith("at://"));
  if (ids.length === 0) throw new Error("missing_bluesky_uris");
  const query = new URLSearchParams();
  for (const id of ids) query.append("uris", id);
  const result = await requestJson<{
    posts?: Array<{ uri?: string; likeCount?: number; replyCount?: number; repostCount?: number; quoteCount?: number }>;
  }>(fetchImpl, `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?${query}`);
  const totals = { likes: 0, replies: 0, reposts: 0, quotes: 0 };
  for (const post of result.posts ?? []) {
    totals.likes += Number(post.likeCount ?? 0);
    totals.replies += Number(post.replyCount ?? 0);
    totals.reposts += Number(post.repostCount ?? 0);
    totals.quotes += Number(post.quoteCount ?? 0);
  }
  return { metrics: totals, source: "bluesky_public_api", raw: result };
}

async function collectMastodon(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const ids = task.externalIds
    .map((id) => id.match(/\/(\d+)(?:$|[?#])/)?.[1] ?? (/^\d+$/.test(id) ? id : null))
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) throw new Error("missing_mastodon_status_ids");
  const configuredHost = config.MASTODON_INSTANCE ?? "https://mastodon.social";
  const host = `${/^https?:\/\//i.test(configuredHost) ? "" : "https://"}${configuredHost}`.replace(/\/$/, "");
  const totals = { likes: 0, replies: 0, reposts: 0 };
  const parts = [];
  for (const id of ids) {
    const status = await requestJson<{ favourites_count?: number; replies_count?: number; reblogs_count?: number }>(
      fetchImpl,
      `${host}/api/v1/statuses/${id}`,
    );
    const part = {
      id,
      likes: Number(status.favourites_count ?? 0),
      replies: Number(status.replies_count ?? 0),
      reposts: Number(status.reblogs_count ?? 0),
    };
    totals.likes += part.likes;
    totals.replies += part.replies;
    totals.reposts += part.reposts;
    parts.push(part);
  }
  return { metrics: totals, source: "mastodon_public_api", raw: { parts } };
}

async function collectGitHub(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  if (!config.GITHUB_DISCUSSIONS_TOKEN) throw new Error("missing_github_discussions_token");
  const match = (task.url ?? task.externalId ?? "").match(/github\.com\/([^/]+)\/([^/]+)\/discussions\/(\d+)/);
  if (!match) throw new Error("missing_github_discussion_url");
  const [, owner, repo, number] = match;
  const result = await requestJson<{
    data?: { repository?: { discussion?: { comments?: { totalCount?: number }; reactions?: { totalCount?: number } } } };
  }>(fetchImpl, "https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.GITHUB_DISCUSSIONS_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "alexgetman-backend/1.0",
    },
    body: JSON.stringify({
      query:
        "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){discussion(number:$number){comments{totalCount} reactions{totalCount}}}}",
      variables: { owner, repo, number: Number(number) },
    }),
  });
  const discussion = result.data?.repository?.discussion;
  return {
    metrics: { likes: Number(discussion?.reactions?.totalCount ?? 0), replies: Number(discussion?.comments?.totalCount ?? 0) },
    source: "github_graphql",
    raw: { owner, repo, number },
  };
}

async function collectInstagramStory(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const token =
    task.target === "instagram_stories_ru"
      ? (config.INSTAGRAM_RU_ACCESS_TOKEN ?? config.INSTAGRAM_ACCESS_TOKEN)
      : (config.INSTAGRAM_EN_ACCESS_TOKEN ?? config.INSTAGRAM_ACCESS_TOKEN);
  if (!token || !task.externalId) throw new Error("missing_instagram_story_token_or_id");
  const host = token.startsWith("IG") ? "graph.instagram.com" : "graph.facebook.com";
  const version = host === "graph.instagram.com" ? config.INSTAGRAM_GRAPH_API_VERSION : config.FACEBOOK_GRAPH_API_VERSION;
  const insights = await requestJson<{ data?: Array<{ name?: string; values?: Array<{ value?: number }> }> }>(
    fetchImpl,
    graphUrl(`https://${host}/${version}/${task.externalId}/insights`, token, {
      metric: "views,reach,replies,shares,total_interactions,navigation",
    }),
  );
  const values = Object.fromEntries((insights.data ?? []).map((item) => [item.name ?? "", Number(item.values?.[0]?.value ?? 0)]));
  let likes = 0;
  try {
    likes = Number(
      (
        await requestJson<{ like_count?: number }>(
          fetchImpl,
          graphUrl(`https://${host}/${version}/${task.externalId}`, token, { fields: "like_count,comments_count" }),
        )
      ).like_count ?? 0,
    );
  } catch {
    // Story insights remain useful even when media fields have expired.
  }
  return {
    metrics: {
      views: values.views ?? values.reach ?? 0,
      reach: values.reach ?? 0,
      likes,
      replies: values.replies ?? 0,
      reposts: values.shares ?? 0,
      total_interactions: values.total_interactions ?? 0,
      navigation: values.navigation ?? 0,
    },
    source: "instagram_graph_api",
    raw: insights,
  };
}

async function collectTelegramStory(task: MetricTask, config: BackendConfig): Promise<MetricResult> {
  if (
    !config.TELEGRAM_CHANNEL_STORIES_API_ID ||
    !config.TELEGRAM_CHANNEL_STORIES_API_HASH ||
    !config.TELEGRAM_CHANNEL_STORIES_SESSION ||
    !task.externalId
  )
    throw new Error("missing_telegram_story_credentials_or_id");
  const instance = createChannelStoryClient(config);
  await instance.connect();
  try {
    const story = (await instance.getStoriesById(config.CHANNEL_USERNAME.replace(/^@/, ""), Number(task.externalId)))[0];
    if (!story) throw new Error(`telegram_story_not_found:${task.externalId}`);
    const interactions = story.interactions;
    const reactions = Number(interactions?.reactionsCount ?? 0);
    const forwards = Number(interactions?.forwardsCount ?? 0);
    return {
      metrics: {
        views: Number(interactions?.viewsCount ?? 0),
        likes: reactions,
        reposts: forwards,
        replies: 0,
        total_interactions: reactions + forwards,
      },
      source: "telegram_mtproto",
      raw: { story_id: task.externalId },
    };
  } finally {
    await instance.destroy();
  }
}

async function collectX(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  if (!task.externalId) throw new Error("missing_x_tweet_id");
  const url = `https://api.twitter.com/2/tweets/${encodeURIComponent(task.externalId)}?tweet.fields=public_metrics`;
  const response = await fetchImpl(url, { headers: { Authorization: oauthAuthorization("GET", url, config) } });
  const body = await response.text();
  if (!response.ok) throw new Error(`X metrics ${response.status}: ${body}`);
  const result = JSON.parse(body) as {
    data?: {
      public_metrics?: {
        impression_count?: number;
        like_count?: number;
        reply_count?: number;
        retweet_count?: number;
        quote_count?: number;
      };
    };
  };
  const metrics = result.data?.public_metrics;
  return {
    metrics: {
      views: Number(metrics?.impression_count ?? 0),
      likes: Number(metrics?.like_count ?? 0),
      replies: Number(metrics?.reply_count ?? 0),
      reposts: Number(metrics?.retweet_count ?? 0),
      quotes: Number(metrics?.quote_count ?? 0),
    },
    source: "x_api_v2",
    raw: result,
  };
}

async function collectLinkedIn(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  if (!config.LINKEDIN_ACCESS_TOKEN || !task.externalId) throw new Error("missing_linkedin_token_or_id");
  const response = await requestJson<{ likesSummary?: { totalLikes?: number }; commentsSummary?: { totalFirstLevelComments?: number } }>(
    fetchImpl,
    `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(task.externalId)}`,
    {
      headers: {
        Authorization: `Bearer ${config.LINKEDIN_ACCESS_TOKEN}`,
        "Linkedin-Version": config.LINKEDIN_API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    },
  );
  return {
    metrics: {
      likes: Number(response.likesSummary?.totalLikes ?? 0),
      replies: Number(response.commentsSummary?.totalFirstLevelComments ?? 0),
    },
    source: "linkedin_social_actions",
    raw: response,
  };
}

function graphUrl(base: string, token: string, query: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  url.searchParams.set("access_token", token);
  return url.toString();
}

function parseCompactCount(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value
    .replace(/&nbsp;|\s/g, "")
    .replace(",", ".")
    .toLowerCase();
  const multiplier = normalized.endsWith("k") ? 1_000 : normalized.endsWith("m") ? 1_000_000 : 1;
  const number = Number.parseFloat(multiplier === 1 ? normalized : normalized.slice(0, -1));
  return Number.isFinite(number) ? Math.trunc(number * multiplier) : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
