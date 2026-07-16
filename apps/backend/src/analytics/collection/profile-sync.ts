import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { oauthAuthorization } from "../../foundation/external/x-oauth.js";
import { youtubeAccessToken } from "../../foundation/external/youtube.js";
import { requestJson } from "../../foundation/http.js";
import { canSync, markSynced, metricNumber, recordProfileSnapshot } from "../snapshots/creator-store.js";

type YouTubeChannel = {
  items?: Array<{
    snippet?: { title?: string };
    statistics?: Record<string, string>;
  }>;
};
type YouTubeReport = {
  columnHeaders?: Array<{ name?: string }>;
  rows?: Array<Array<string | number>>;
};
type InstagramProfile = {
  username?: string;
  biography?: string;
  followers_count?: number;
  media_count?: number;
};

export async function syncYouTubeProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  try {
    const token = await youtubeAccessToken(config);
    const auth = { Authorization: `Bearer ${token}` };
    const channel = await requestJson<YouTubeChannel>(
      fetchImpl,
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
      { headers: auth },
    );
    const channelItem = channel.items?.[0];
    const period = await youtubeReport(fetchImpl, token);
    recordProfileSnapshot(backendDb, {
      platform: "youtube",
      account: channelItem?.snippet?.title ?? "channel",
      source: "youtube_data_api",
      metrics: {
        title: channelItem?.snippet?.title ?? "YouTube",
        subscriberCount: metricNumber(channelItem?.statistics?.subscriberCount),
        viewCount: metricNumber(channelItem?.statistics?.viewCount),
        videoCount: metricNumber(channelItem?.statistics?.videoCount),
        ...period,
      },
    });
    markSynced(backendDb, "youtube");
  } catch (error) {
    markSynced(backendDb, "youtube", error instanceof Error ? error.message : String(error));
  }
}

async function youtubeReport(fetchImpl: typeof fetch, token: string): Promise<Record<string, number>> {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", start);
  url.searchParams.set("endDate", end);
  url.searchParams.set("metrics", "views,likes,comments,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost");
  const report = await requestJson<YouTubeReport>(fetchImpl, url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return Object.fromEntries(
    (report.columnHeaders ?? []).map((header, index) => [header.name ?? `metric_${index}`, metricNumber(report.rows?.[0]?.[index])]),
  );
}

export async function syncInstagramProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  try {
    const token = config.INSTAGRAM_ACCESS_TOKEN;
    const userId = config.INSTAGRAM_USER_ID;
    if (!token || !userId) throw new Error("Instagram credentials are missing");
    const profileData = await requestJson<InstagramProfile>(
      fetchImpl,
      `https://graph.facebook.com/${config.INSTAGRAM_GRAPH_API_VERSION}/${userId}?fields=username,biography,followers_count,media_count&access_token=${encodeURIComponent(token)}`,
    );
    recordProfileSnapshot(backendDb, {
      platform: "instagram",
      account: profileData.username ?? "instagram",
      source: "instagram_graph_api",
      metrics: {
        username: profileData.username ?? "Instagram",
        biography: profileData.biography ?? "",
        followersCount: metricNumber(profileData.followers_count),
        mediaCount: metricNumber(profileData.media_count),
      },
    });
    markSynced(backendDb, "instagram");
  } catch (error) {
    markSynced(backendDb, "instagram", error instanceof Error ? error.message : String(error));
  }
}

type FacebookPage = { name?: string; followers_count?: number; fan_count?: number; talking_about_count?: number };
type XProfile = {
  data?: {
    id?: string;
    name?: string;
    username?: string;
    public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number; listed_count?: number };
  };
};
type BlueskyProfile = {
  did?: string;
  handle?: string;
  displayName?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
};
type MastodonProfile = {
  id?: string;
  acct?: string;
  display_name?: string;
  followers_count?: number;
  following_count?: number;
  statuses_count?: number;
};
type GitHubProfile = { login?: string; followers?: number; following?: number };
type GitHubRepo = { stargazers_count?: number };
type TelegramCount = { ok?: boolean; result?: number };
type ThreadsProfile = { id?: string; username?: string };

export async function syncFacebookProfile(
  config: BackendConfig,
  backendDb: BackendDb,
  locale: "en" | "ru",
  fetchImpl: typeof fetch,
): Promise<void> {
  const source = `facebook_profile_${locale}`;
  try {
    const pageId = locale === "ru" ? config.FACEBOOK_RU_PAGE_ID : config.FACEBOOK_PAGE_ID;
    const token = locale === "ru" ? config.FACEBOOK_RU_PAGE_ACCESS_TOKEN : config.FACEBOOK_PAGE_ACCESS_TOKEN;
    if (!pageId || !token) throw new Error("Facebook Page credentials are missing");
    const page = await requestJson<FacebookPage>(
      fetchImpl,
      `https://graph.facebook.com/${config.FACEBOOK_GRAPH_API_VERSION}/${pageId}?fields=name,followers_count,fan_count,talking_about_count&access_token=${encodeURIComponent(token)}`,
    );
    recordProfileSnapshot(backendDb, {
      platform: `facebook_${locale}`,
      account: page.name ?? pageId,
      source: "facebook_graph_api",
      metrics: {
        name: page.name ?? pageId,
        followersCount: metricNumber(page.followers_count),
        fanCount: metricNumber(page.fan_count),
        talkingAboutCount: metricNumber(page.talking_about_count),
      },
    });
    markSynced(backendDb, source);
  } catch (error) {
    markSynced(backendDb, source, error instanceof Error ? error.message : String(error));
  }
}

export async function syncXProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  try {
    if (!config.ENABLE_X_PROFILE_METRICS) return;
    const url = "https://api.x.com/2/users/me?user.fields=public_metrics";
    const profile = await requestJson<XProfile>(fetchImpl, url, { headers: { Authorization: oauthAuthorization("GET", url, config) } });
    const user = profile.data;
    if (!user?.id) throw new Error("X profile response has no user");
    recordProfileSnapshot(backendDb, {
      platform: "x",
      account: user.username ?? user.id,
      source: "x_user_api",
      metrics: {
        name: user.name ?? user.username ?? user.id,
        followersCount: metricNumber(user.public_metrics?.followers_count),
        followingCount: metricNumber(user.public_metrics?.following_count),
        postsCount: metricNumber(user.public_metrics?.tweet_count),
        listedCount: metricNumber(user.public_metrics?.listed_count),
      },
    });
    markSynced(backendDb, "x_profile");
  } catch (error) {
    markSynced(backendDb, "x_profile", error instanceof Error ? error.message : String(error));
  }
}

export async function syncCommunityProfiles(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (config.BLUESKY_HANDLE && canSync(backendDb, "bluesky_profile")) jobs.push(syncBlueskyProfile(config, backendDb, fetchImpl));
  if (config.MASTODON_INSTANCE && config.MASTODON_ACCESS_TOKEN && canSync(backendDb, "mastodon_profile"))
    jobs.push(syncMastodonProfile(config, backendDb, fetchImpl));
  if (config.GITHUB_DISCUSSIONS_TOKEN && canSync(backendDb, "github_profile")) jobs.push(syncGitHubProfile(config, backendDb, fetchImpl));
  if (config.controllerBotToken && canSync(backendDb, "telegram_profile")) jobs.push(syncTelegramProfile(config, backendDb, fetchImpl));
  if (config.THREADS_ACCESS_TOKEN && canSync(backendDb, "threads_profile")) jobs.push(syncThreadsProfile(config, backendDb, fetchImpl));
  if (config.DEVTO_API_KEY && canSync(backendDb, "devto_profile")) jobs.push(syncDevtoProfile(config, backendDb, fetchImpl));
  await Promise.all(jobs);
}

async function syncBlueskyProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  try {
    if (!config.BLUESKY_HANDLE) return;
    const profile = await requestJson<BlueskyProfile>(
      fetchImpl,
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(config.BLUESKY_HANDLE)}`,
    );
    recordProfileSnapshot(backendDb, {
      platform: "bluesky",
      account: profile.handle ?? config.BLUESKY_HANDLE,
      source: "bluesky_public_api",
      metrics: {
        name: profile.displayName ?? profile.handle ?? config.BLUESKY_HANDLE,
        followersCount: metricNumber(profile.followersCount),
        followingCount: metricNumber(profile.followsCount),
        postsCount: metricNumber(profile.postsCount),
      },
    });
    markSynced(backendDb, "bluesky_profile");
  } catch (error) {
    markSynced(backendDb, "bluesky_profile", error instanceof Error ? error.message : String(error));
  }
}

async function syncMastodonProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  try {
    if (!config.MASTODON_INSTANCE || !config.MASTODON_ACCESS_TOKEN) return;
    const host = `${/^https?:\/\//i.test(config.MASTODON_INSTANCE) ? "" : "https://"}${config.MASTODON_INSTANCE}`.replace(/\/$/, "");
    const profile = await requestJson<MastodonProfile>(fetchImpl, `${host}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${config.MASTODON_ACCESS_TOKEN}` },
    });
    recordProfileSnapshot(backendDb, {
      platform: "mastodon",
      account: profile.acct ?? profile.id ?? "mastodon",
      source: "mastodon_api",
      metrics: {
        name: profile.display_name ?? profile.acct ?? "Mastodon",
        followersCount: metricNumber(profile.followers_count),
        followingCount: metricNumber(profile.following_count),
        postsCount: metricNumber(profile.statuses_count),
      },
    });
    markSynced(backendDb, "mastodon_profile");
  } catch (error) {
    markSynced(backendDb, "mastodon_profile", error instanceof Error ? error.message : String(error));
  }
}

async function syncGitHubProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  try {
    if (!config.GITHUB_DISCUSSIONS_TOKEN) return;
    const headers = { Authorization: `Bearer ${config.GITHUB_DISCUSSIONS_TOKEN}`, "User-Agent": "alexgetman-backend/1.0" };
    const profile = await requestJson<GitHubProfile>(fetchImpl, "https://api.github.com/user", { headers });
    let stars = 0;
    for (let page = 1; page <= 20; page += 1) {
      const repositories = await requestJson<GitHubRepo[]>(
        fetchImpl,
        `https://api.github.com/user/repos?affiliation=owner&per_page=100&page=${page}`,
        { headers },
      );
      stars += repositories.reduce((total, repository) => total + (metricNumber(repository.stargazers_count) ?? 0), 0);
      if (repositories.length < 100) break;
      if (page === 20) throw new Error("GitHub owned-repository list exceeds safe analytics page limit");
    }
    recordProfileSnapshot(backendDb, {
      platform: "github",
      account: profile.login ?? "github",
      source: "github_api",
      metrics: {
        name: profile.login ?? "GitHub",
        followersCount: metricNumber(profile.followers),
        followingCount: metricNumber(profile.following),
        stars,
      },
    });
    markSynced(backendDb, "github_profile");
  } catch (error) {
    markSynced(backendDb, "github_profile", error instanceof Error ? error.message : String(error));
  }
}

async function syncTelegramProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  try {
    if (!config.controllerBotToken) return;
    const result = await requestJson<TelegramCount>(
      fetchImpl,
      `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/bot${config.controllerBotToken}/getChatMemberCount`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: `@${config.CHANNEL_USERNAME.replace(/^@/, "")}` }),
      },
    );
    if (!result.ok || result.result == null) throw new Error("Telegram channel member count is unavailable");
    recordProfileSnapshot(backendDb, {
      platform: "telegram",
      account: config.CHANNEL_USERNAME.replace(/^@/, ""),
      source: "telegram_bot_api",
      metrics: { followersCount: metricNumber(result.result) },
    });
    markSynced(backendDb, "telegram_profile");
  } catch (error) {
    markSynced(backendDb, "telegram_profile", error instanceof Error ? error.message : String(error));
  }
}

async function syncThreadsProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  try {
    const token = config.THREADS_ACCESS_TOKEN;
    if (!token) return;
    const profile = await requestJson<ThreadsProfile>(
      fetchImpl,
      `https://graph.threads.net/v1.0/me?fields=id,username&access_token=${encodeURIComponent(token)}`,
    );
    if (!profile.id) throw new Error("Threads profile response has no account");
    recordProfileSnapshot(backendDb, {
      platform: "threads",
      account: profile.username ?? profile.id,
      source: "threads_api",
      metrics: { name: profile.username ?? profile.id },
    });
    markSynced(backendDb, "threads_profile");
  } catch (error) {
    markSynced(backendDb, "threads_profile", error instanceof Error ? error.message : String(error));
  }
}

async function syncDevtoProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  try {
    if (!config.DEVTO_API_KEY) return;
    const headers = { "api-key": config.DEVTO_API_KEY, "User-Agent": "alexgetman-backend/1.0" };
    const user = await requestJson<{ username?: string; name?: string }>(fetchImpl, "https://dev.to/api/users/me", { headers });
    if (!user.username) throw new Error("Dev.to profile response has no username");
    const followers = await countDevtoPages(fetchImpl, "https://dev.to/api/followers/users?per_page=1000", headers);
    const posts = await countDevtoPages(fetchImpl, "https://dev.to/api/articles/me?per_page=1000", headers);
    recordProfileSnapshot(backendDb, {
      platform: "devto",
      account: user.username,
      source: "devto_api",
      metrics: { name: user.name ?? user.username, followersCount: followers, postsCount: posts },
    });
    markSynced(backendDb, "devto_profile");
  } catch (error) {
    markSynced(backendDb, "devto_profile", error instanceof Error ? error.message : String(error));
  }
}

async function countDevtoPages(fetchImpl: typeof fetch, base: string, headers: Record<string, string>): Promise<number> {
  let total = 0;
  for (let page = 1; page <= 20; page += 1) {
    const rows = await requestJson<unknown[]>(fetchImpl, `${base}&page=${page}`, { headers });
    total += rows.length;
    if (rows.length < 1000) return total;
  }
  throw new Error("Dev.to profile pagination exceeded the safe daily limit");
}
