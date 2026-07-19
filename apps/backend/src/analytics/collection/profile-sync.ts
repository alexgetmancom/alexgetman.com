import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { createChannelStoryClient } from "../../foundation/external/telegram-session.js";
import { oauthAuthorization } from "../../foundation/external/x-oauth.js";
import { youtubeAccessToken } from "../../foundation/external/youtube.js";
import { requestJson } from "../../foundation/http.js";
import { videoDeliveryRoute } from "../../publishing/delivery-provider.js";
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
type ZernioAccount = { _id?: string; username?: string; displayName?: string; followersCount?: number };
type ZernioAccounts = { accounts?: ZernioAccount[] } | ZernioAccount[];
type ZernioInsights = { metrics?: Record<string, { total?: number }> };

function studioAudiencePlatforms(config: BackendConfig): string[] {
  return [
    ...(config.studio.modules.text_posting ? ["telegram"] : []),
    ...(config.studio.modules.video_posting && config.studio.modules.youtube ? ["youtube"] : []),
    ...(config.studio.modules.video_posting && config.studio.modules.instagram ? ["instagram"] : []),
  ];
}

/** Runs one platform sync and records its outcome; every platform below funnels through
 * this so a new integration can't forget the success/failure timestamp update. */
async function synced(backendDb: BackendDb, source: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    markSynced(backendDb, source);
  } catch (error) {
    markSynced(backendDb, source, error instanceof Error ? error.message : String(error));
  }
}

export async function syncYouTubeProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  await synced(backendDb, "youtube", async () => {
    const token = await youtubeAccessToken(config);
    const auth = { Authorization: `Bearer ${token}` };
    const channel = await requestJson<YouTubeChannel>(
      fetchImpl,
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
      { headers: auth },
    );
    const channelItem = channel.items?.[0];
    const [today, week, period] = await Promise.all([
      youtubeReport(fetchImpl, token, 1),
      youtubeReport(fetchImpl, token, 7),
      youtubeReport(fetchImpl, token, 30),
    ]);
    recordProfileSnapshot(backendDb, {
      platform: "youtube",
      account: channelItem?.snippet?.title ?? "channel",
      source: "youtube_data_api",
      audiencePlatforms: studioAudiencePlatforms(config),
      metrics: {
        title: channelItem?.snippet?.title ?? "YouTube",
        subscriberCount: metricNumber(channelItem?.statistics?.subscriberCount),
        viewCount: metricNumber(channelItem?.statistics?.viewCount),
        videoCount: metricNumber(channelItem?.statistics?.videoCount),
        ...period,
        ...periodMetrics(today, 1),
        ...periodMetrics(week, 7),
      },
      // Keep the current channel total once per hour. Analytics reports lag;
      // the durable channel counter lets the 24-hour dashboard calculate a
      // live view delta without polling any text-post platforms.
      resolution: "hour",
    });
  });
}

function periodMetrics(metrics: Record<string, number>, days: 1 | 7): Record<string, number> {
  return Object.fromEntries(Object.entries(metrics).map(([name, value]) => [`${name}${days}d`, value]));
}

async function youtubeReport(fetchImpl: typeof fetch, token: string, days = 30): Promise<Record<string, number>> {
  // YouTube Analytics defines report days in Pacific time and may omit the
  // most recent days. Ask only for completed days; a currently-open calendar
  // day otherwise produces an empty report that looks like a real zero.
  const pacificDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
  const completedEnd = new Date(`${pacificDay.year}-${pacificDay.month}-${pacificDay.day}T12:00:00Z`);
  completedEnd.setUTCDate(completedEnd.getUTCDate() - 1);
  const end = completedEnd.toISOString().slice(0, 10);
  const startDate = new Date(completedEnd);
  startDate.setUTCDate(startDate.getUTCDate() - days + 1);
  const start = startDate.toISOString().slice(0, 10);
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", start);
  url.searchParams.set("endDate", end);
  url.searchParams.set(
    "metrics",
    "views,likes,comments,shares,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
  );
  const report = await requestJson<YouTubeReport>(fetchImpl, url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return Object.fromEntries(
    (report.columnHeaders ?? []).map((header, index) => [header.name ?? `metric_${index}`, metricNumber(report.rows?.[0]?.[index])]),
  );
}

export async function syncInstagramProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  await synced(backendDb, "instagram", async () => {
    if (videoDeliveryRoute(config, "instagram_reels").provider === "zernio") {
      await syncZernioInstagramProfile(config, backendDb, fetchImpl);
      return;
    }
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
      audiencePlatforms: studioAudiencePlatforms(config),
      metrics: {
        username: profileData.username ?? "Instagram",
        biography: profileData.biography ?? "",
        followersCount: metricNumber(profileData.followers_count),
        mediaCount: metricNumber(profileData.media_count),
      },
    });
  });
}

async function syncZernioInstagramProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  const route = videoDeliveryRoute(config, "instagram_reels");
  if (!config.ZERNIO_API_KEY || !route.accountId) throw new Error("Zernio Instagram credentials are missing");
  const headers = { Authorization: `Bearer ${config.ZERNIO_API_KEY}` };
  const accounts = await requestJson<ZernioAccounts>(fetchImpl, "https://zernio.com/api/v1/accounts", { headers });
  const account = (Array.isArray(accounts) ? accounts : (accounts.accounts ?? [])).find((item) => item._id === route.accountId);
  if (!account) throw new Error("Zernio Instagram account was not found");
  const [todayInsights, weekInsights, insights] = await Promise.all([
    zernioInsights(fetchImpl, headers, route.accountId, 1),
    zernioInsights(fetchImpl, headers, route.accountId, 7),
    zernioInsights(fetchImpl, headers, route.accountId, 30),
  ]);
  const history = await requestJson<ZernioInsights>(
    fetchImpl,
    `https://zernio.com/api/v1/analytics/instagram/follower-history?${new URLSearchParams({ accountId: route.accountId })}`,
    { headers },
  );
  const metric = (name: string) => metricNumber(insights.metrics?.[name]?.total);
  recordProfileSnapshot(backendDb, {
    platform: "instagram",
    account: account.username ?? route.accountId,
    source: "zernio",
    audiencePlatforms: studioAudiencePlatforms(config),
    metrics: {
      username: account.username ?? account.displayName ?? "Instagram",
      // Zernio's follower-history series starts only after its daily snapshotter
      // sees an account. A just-connected account can therefore report `0` for
      // the historical aggregate while /accounts already has the live count.
      // The connected-account value is the authoritative current follower total.
      followersCount: metricNumber(account.followersCount ?? history.metrics?.follower_count?.total),
      followersGained30d: metricNumber(history.metrics?.followers_gained?.total),
      followersLost30d: metricNumber(history.metrics?.followers_lost?.total),
      reach30d: metric("reach"),
      views30d: metric("views"),
      accountsEngaged30d: metric("accounts_engaged"),
      interactions30d: metric("total_interactions"),
      likes30d: metric("likes"),
      comments30d: metric("comments"),
      saves30d: metric("saves"),
      shares30d: metric("shares"),
      reposts30d: metric("reposts"),
      profileLinksTaps30d: metric("profile_links_taps"),
      ...zernioPeriodMetrics(todayInsights, 1),
      ...zernioPeriodMetrics(weekInsights, 7),
    },
  });
}

async function zernioInsights(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  accountId: string,
  days: 1 | 7 | 30,
): Promise<ZernioInsights> {
  const query = new URLSearchParams({
    accountId,
    metrics: "reach,views,accounts_engaged,total_interactions,comments,likes,saves,shares,reposts,profile_links_taps",
    since: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10),
    until: new Date().toISOString().slice(0, 10),
  });
  return requestJson<ZernioInsights>(fetchImpl, `https://zernio.com/api/v1/analytics/instagram/account-insights?${query}`, { headers });
}

function zernioPeriodMetrics(insights: ZernioInsights, days: 1 | 7): Record<string, number> {
  return Object.fromEntries(Object.entries(insights.metrics ?? {}).map(([name, value]) => [`${name}${days}d`, metricNumber(value.total)]));
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
type TelegramBroadcastStats = {
  _?: string;
  followers?: { current?: number; previous?: number };
  viewsPerPost?: { current?: number; previous?: number };
  sharesPerPost?: { current?: number; previous?: number };
  reactionsPerPost?: { current?: number; previous?: number };
  period?: { minDate?: number; maxDate?: number };
};
type ThreadsProfile = { id?: string; username?: string };
type DevtoArticle = { user?: { username?: string; name?: string } };

export async function syncFacebookProfile(
  config: BackendConfig,
  backendDb: BackendDb,
  locale: "en" | "ru",
  fetchImpl: typeof fetch,
): Promise<void> {
  const source = `facebook_profile_${locale}`;
  await synced(backendDb, source, async () => {
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
  });
}

export async function syncXProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  if (!config.ENABLE_X_PROFILE_METRICS) return;
  await synced(backendDb, "x_profile", async () => {
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
  });
}

export async function syncCommunityProfiles(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  const jobs: Promise<void>[] = [];
  const interval = config.CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS;
  if (config.BLUESKY_HANDLE && canSync(backendDb, "bluesky_profile", interval)) jobs.push(syncBlueskyProfile(config, backendDb, fetchImpl));
  if (config.MASTODON_INSTANCE && config.MASTODON_ACCESS_TOKEN && canSync(backendDb, "mastodon_profile", interval))
    jobs.push(syncMastodonProfile(config, backendDb, fetchImpl));
  if (config.GITHUB_DISCUSSIONS_TOKEN && canSync(backendDb, "github_profile", interval))
    jobs.push(syncGitHubProfile(config, backendDb, fetchImpl));
  // A controller bot is not itself a Telegram publishing channel. In a
  // video-only Studio (such as Maru) CHANNEL_USERNAME may merely fall back to
  // the legacy default, so collecting it would leak another creator's audience
  // into this dashboard.
  if (config.studio.modules.text_posting && config.controllerBotToken && canSync(backendDb, "telegram_profile", interval))
    jobs.push(syncTelegramProfile(config, backendDb, fetchImpl));
  if (config.THREADS_ACCESS_TOKEN && canSync(backendDb, "threads_profile", interval))
    jobs.push(syncThreadsProfile(config, backendDb, fetchImpl));
  if (config.DEVTO_API_KEY && canSync(backendDb, "devto_profile", interval)) jobs.push(syncDevtoProfile(config, backendDb, fetchImpl));
  await Promise.all(jobs);
}

async function syncBlueskyProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  if (!config.BLUESKY_HANDLE) return;
  const handle = config.BLUESKY_HANDLE;
  await synced(backendDb, "bluesky_profile", async () => {
    const profile = await requestJson<BlueskyProfile>(
      fetchImpl,
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`,
    );
    recordProfileSnapshot(backendDb, {
      platform: "bluesky",
      account: profile.handle ?? handle,
      source: "bluesky_public_api",
      metrics: {
        name: profile.displayName ?? profile.handle ?? handle,
        followersCount: metricNumber(profile.followersCount),
        followingCount: metricNumber(profile.followsCount),
        postsCount: metricNumber(profile.postsCount),
      },
    });
  });
}

async function syncMastodonProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  const instance = config.MASTODON_INSTANCE;
  const accessToken = config.MASTODON_ACCESS_TOKEN;
  if (!instance || !accessToken) return;
  await synced(backendDb, "mastodon_profile", async () => {
    const host = `${/^https?:\/\//i.test(instance) ? "" : "https://"}${instance}`.replace(/\/$/, "");
    const profile = await requestJson<MastodonProfile>(fetchImpl, `${host}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${accessToken}` },
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
  });
}

async function syncGitHubProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  if (!config.GITHUB_DISCUSSIONS_TOKEN) return;
  await synced(backendDb, "github_profile", async () => {
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
  });
}

async function syncTelegramProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  await synced(backendDb, "telegram_profile", async () => {
    const mtprotoMetrics = await collectTelegramChannelStats(config);
    if (mtprotoMetrics) {
      recordProfileSnapshot(backendDb, {
        platform: "telegram",
        account: config.CHANNEL_USERNAME.replace(/^@/, ""),
        source: "telegram_mtproto_stats",
        metrics: mtprotoMetrics,
      });
      return;
    }
    if (!config.controllerBotToken) throw new Error("Telegram channel credentials are missing");
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
  });
}

async function collectTelegramChannelStats(config: BackendConfig): Promise<Record<string, number> | null> {
  if (!config.TELEGRAM_CHANNEL_STORIES_API_ID || !config.TELEGRAM_CHANNEL_STORIES_API_HASH || !config.TELEGRAM_CHANNEL_STORIES_SESSION)
    return null;
  const client = createChannelStoryClient(config);
  await client.connect();
  try {
    const channel = await client.resolveChannel(`@${config.CHANNEL_USERNAME.replace(/^@/, "")}`, true);
    const stats = (await client.call({ _: "stats.getBroadcastStats", channel })) as TelegramBroadcastStats;
    if (stats._ !== "stats.broadcastStats") throw new Error("Telegram returned an unexpected channel statistics response");
    return telegramChannelMetrics(stats);
  } finally {
    await client.destroy();
  }
}

function telegramChannelMetrics(stats: TelegramBroadcastStats): Record<string, number> {
  return {
    followersCount: metricNumber(stats.followers?.current),
    followersPrevious: metricNumber(stats.followers?.previous),
    averageViewsPerPost: metricNumber(stats.viewsPerPost?.current),
    averageSharesPerPost: metricNumber(stats.sharesPerPost?.current),
    averageReactionsPerPost: metricNumber(stats.reactionsPerPost?.current),
    periodStart: metricNumber(stats.period?.minDate),
    periodEnd: metricNumber(stats.period?.maxDate),
  };
}

async function syncThreadsProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  const token = config.THREADS_ACCESS_TOKEN;
  if (!token) return;
  await synced(backendDb, "threads_profile", async () => {
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
  });
}

async function syncDevtoProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  const apiKey = config.DEVTO_API_KEY;
  if (!apiKey) return;
  await synced(backendDb, "devto_profile", async () => {
    const headers = { "api-key": apiKey, "User-Agent": "alexgetman-backend/1.0" };
    // Dev.to accepts a publishing token for articles/me but may reject users/me.
    // Derive the account from the authenticated article payload instead of requiring
    // a broader token scope just to collect this optional profile projection.
    const firstArticles = await requestJson<DevtoArticle[]>(fetchImpl, "https://dev.to/api/articles/me?per_page=1&page=1", { headers });
    const user = firstArticles[0]?.user;
    const posts = await countDevtoPages(fetchImpl, "https://dev.to/api/articles/me?per_page=1000", headers);
    let followers: number | undefined;
    try {
      followers = await countDevtoPages(fetchImpl, "https://dev.to/api/followers/users?per_page=1000", headers);
    } catch {
      // The followers endpoint is optional and currently returns 5xx for some
      // authenticated Dev.to accounts. Keep article analytics healthy instead.
    }
    recordProfileSnapshot(backendDb, {
      platform: "devto",
      account: user?.username ?? "devto",
      source: "devto_api",
      metrics: {
        name: user?.name ?? user?.username ?? "Dev.to",
        ...(followers == null ? {} : { followersCount: followers }),
        postsCount: posts,
      },
    });
  });
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
