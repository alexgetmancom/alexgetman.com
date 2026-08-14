import crypto from "node:crypto";
import type { ChannelConnection } from "../../channels/registry.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { instagramCredentialsForLocale, instagramGraphHost } from "../../foundation/external/instagram.js";
import { createChannelStoryClient } from "../../foundation/external/telegram-session.js";
import { youtubeAccessToken } from "../../foundation/external/youtube.js";
import { zernioAccount, zernioRequest } from "../../foundation/external/zernio.js";
import { requestJson } from "../../foundation/http.js";
import { withTimeout } from "../../foundation/runtime/timeout.js";
import { claimSync, markSynced, metricNumber, recordProfileSnapshot } from "../snapshots/creator-store.js";
import { queryYouTubeAnalytics, youtubeAnalyticsDateRange } from "./youtube-analytics.js";

type YouTubeChannel = {
  items?: Array<{
    snippet?: { title?: string };
    statistics?: Record<string, string>;
  }>;
};
type InstagramProfile = {
  username?: string;
  biography?: string;
  followers_count?: number;
  media_count?: number;
};
type ZernioInsights = { metrics?: Record<string, { total?: number }> };

/** Runs one platform sync and records its outcome; every platform below funnels through
 * this so a new integration can't forget the success/failure timestamp update. */
async function synced(backendDb: BackendDb, source: string, run: () => Promise<void>, owner?: string): Promise<void> {
  try {
    await run();
    markSynced(backendDb, source, null, owner);
  } catch (error) {
    markSynced(backendDb, source, error instanceof Error ? error.message : String(error), owner);
    throw error;
  }
}

export async function syncYouTubeProfile(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch,
  connection: ChannelConnection,
  owner?: string,
): Promise<void> {
  const profileKey = connection.id;
  const locale = connection.locale === "en" ? "en" : "ru";
  await synced(
    backendDb,
    profileKey,
    async () => {
      const token = await youtubeAccessToken(config, fetchImpl, locale);
      const auth = { Authorization: `Bearer ${token}` };
      const channel = await requestJson<YouTubeChannel>(
        fetchImpl,
        "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
        { headers: auth },
      );
      const channelItem = channel.items?.[0];
      const reports = await Promise.allSettled([
        youtubeReport(fetchImpl, token, 1),
        youtubeReport(fetchImpl, token, 7),
        youtubeReport(fetchImpl, token, 30),
      ]);
      const [today = {}, week = {}, period = {}] = reports.map((report) => (report.status === "fulfilled" ? report.value : {}));
      recordProfileSnapshot(backendDb, {
        platform: profileKey,
        account: channelItem?.snippet?.title ?? "channel",
        source: "youtube_data_api",
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
      // The Data API and Analytics API are independently enabled Google
      // services. Keep the live channel counter when Analytics is unavailable,
      // then surface the failing report in analytics_sync for diagnosis.
      const failed = reports.find((report): report is PromiseRejectedResult => report.status === "rejected");
      if (failed) throw failed.reason;
    },
    owner,
  );
}

function periodMetrics(metrics: Record<string, number>, days: 1 | 7): Record<string, number> {
  return Object.fromEntries(Object.entries(metrics).map(([name, value]) => [`${name}${days}d`, value]));
}

async function youtubeReport(fetchImpl: typeof fetch, token: string, days = 30): Promise<Record<string, number>> {
  // YouTube Analytics defines report days in Pacific time and may omit the
  // most recent days. Ask only for completed days; a currently-open calendar
  // day otherwise produces an empty report that looks like a real zero.
  const range = youtubeAnalyticsDateRange(days);
  const report = await queryYouTubeAnalytics(fetchImpl, token, {
    ...range,
    metrics:
      "views,likes,comments,shares,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost",
  });
  return Object.fromEntries(
    (report.columnHeaders ?? []).map((header, index) => [header.name ?? `metric_${index}`, metricNumber(report.rows?.[0]?.[index])]),
  );
}

export async function syncInstagramProfile(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch,
  connection: ChannelConnection,
  owner?: string,
): Promise<void> {
  const profileKey = connection.id;
  await synced(
    backendDb,
    profileKey,
    async () => {
      if (connection.provider === "zernio") {
        await syncZernioInstagramProfile(config, backendDb, fetchImpl, connection);
        return;
      }
      const instagramLocale = connection.locale === "en" ? "en" : "ru";
      const { accessToken: token, userId } = instagramCredentialsForLocale(config, instagramLocale);
      if (!token || !userId) throw new Error("Instagram credentials are missing");
      const host = instagramGraphHost(token);
      const profileData = await requestJson<InstagramProfile>(
        fetchImpl,
        `https://${host}/${config.INSTAGRAM_GRAPH_API_VERSION}/${userId}?fields=username,biography,followers_count,media_count&access_token=${encodeURIComponent(token)}`,
      );
      recordProfileSnapshot(backendDb, {
        platform: profileKey,
        account: profileData.username ?? "instagram",
        source: "instagram_graph_api",
        metrics: {
          username: profileData.username ?? "Instagram",
          biography: profileData.biography ?? "",
          followersCount: metricNumber(profileData.followers_count),
          mediaCount: metricNumber(profileData.media_count),
        },
      });
    },
    owner,
  );
}

/** Keeps a newly registered Zernio platform visible in audience analytics even
 * before a platform-specific insights adapter is implemented. */
export async function syncZernioChannelProfile(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch,
  connection: ChannelConnection,
  owner?: string,
): Promise<void> {
  await synced(
    backendDb,
    connection.id,
    async () => {
      if (!connection.providerAccountId) throw new Error("Zernio channel account is missing");
      const account = await zernioAccount(config, connection.providerAccountId, fetchImpl);
      recordProfileSnapshot(backendDb, {
        platform: connection.id,
        account: account.username ?? connection.providerAccountId,
        source: "zernio",
        metrics: {
          username: account.username ?? account.displayName ?? connection.label,
          followersCount: metricNumber(account.followersCount),
        },
      });
    },
    owner,
  );
}

async function syncZernioInstagramProfile(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch,
  connection: ChannelConnection,
): Promise<void> {
  const accountId = connection.providerAccountId;
  if (!accountId) throw new Error("Zernio Instagram account is missing");
  const account = await zernioAccount(config, accountId, fetchImpl);
  const [todayInsights, weekInsights, insights] = await Promise.all([
    zernioInsights(config, fetchImpl, accountId, 1),
    zernioInsights(config, fetchImpl, accountId, 7),
    zernioInsights(config, fetchImpl, accountId, 30),
  ]);
  const history = await zernioRequest<ZernioInsights>(
    config,
    `analytics/instagram/follower-history?${new URLSearchParams({ accountId })}`,
    fetchImpl,
  );
  const metric = (name: string) => metricNumber(insights.metrics?.[name]?.total);
  recordProfileSnapshot(backendDb, {
    platform: connection.id,
    account: account.username ?? accountId,
    source: "zernio",
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
  config: BackendConfig,
  fetchImpl: typeof fetch,
  accountId: string,
  days: 1 | 7 | 30,
): Promise<ZernioInsights> {
  const query = new URLSearchParams({
    accountId,
    metrics: "reach,views,accounts_engaged,total_interactions,comments,likes,saves,shares,reposts,profile_links_taps",
    since: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10),
    until: new Date().toISOString().slice(0, 10),
  });
  return zernioRequest<ZernioInsights>(config, `analytics/instagram/account-insights?${query}`, fetchImpl);
}

function zernioPeriodMetrics(insights: ZernioInsights, days: 1 | 7): Record<string, number> {
  return Object.fromEntries(Object.entries(insights.metrics ?? {}).map(([name, value]) => [`${name}${days}d`, metricNumber(value.total)]));
}

type XProfile = {
  data?: {
    id?: string;
    name?: string;
    username?: string;
    public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number; listed_count?: number };
  };
};
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

export async function syncXProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch, owner?: string): Promise<void> {
  if (!config.ENABLE_X_PROFILE_METRICS) return;
  await synced(
    backendDb,
    "x_profile",
    async () => {
      const url = "https://api.x.com/2/users/me?user.fields=public_metrics";
      const profile = await requestJson<XProfile>(fetchImpl, url, { headers: { Authorization: `Bearer ${config.X_ACCESS_TOKEN}` } });
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
    },
    owner,
  );
}

export async function syncCommunityProfiles(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch,
  owner?: string,
): Promise<number> {
  const jobs: Promise<void>[] = [];
  const interval = config.CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS;
  const ownerPrefix = owner ?? `community:${crypto.randomUUID()}`;
  // A controller bot is not itself a Telegram publishing channel.
  if (
    config.controllerBotToken &&
    claimSync(backendDb, "telegram_profile", { intervalSeconds: interval, owner: `${ownerPrefix}:telegram` })
  )
    jobs.push(syncTelegramProfile(config, backendDb, fetchImpl, `${ownerPrefix}:telegram`));
  if (
    config.THREADS_RU_ACCESS_TOKEN &&
    claimSync(backendDb, "threads_profile", { intervalSeconds: interval, owner: `${ownerPrefix}:threads` })
  )
    jobs.push(syncThreadsProfile(config, backendDb, fetchImpl, `${ownerPrefix}:threads`));
  await Promise.all(jobs);
  return jobs.length;
}

/** TELEGRAM_CHANNEL_USERNAME may or may not carry a leading "@" depending on how it was
 * configured; this normalizes to the bare handle for account labels and
 * chat_id construction below. */
function channelHandle(config: BackendConfig): string {
  return config.TELEGRAM_CHANNEL_USERNAME.replace(/^@/, "");
}

async function syncTelegramProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch, owner?: string): Promise<void> {
  await synced(
    backendDb,
    "telegram_profile",
    async () => {
      const mtprotoMetrics = await collectTelegramChannelStats(config);
      if (mtprotoMetrics) {
        recordProfileSnapshot(backendDb, {
          platform: "telegram",
          account: channelHandle(config),
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
          body: JSON.stringify({ chat_id: `@${channelHandle(config)}` }),
        },
      );
      if (!result.ok || result.result == null) throw new Error("Telegram channel member count is unavailable");
      recordProfileSnapshot(backendDb, {
        platform: "telegram",
        account: channelHandle(config),
        source: "telegram_bot_api",
        metrics: { followersCount: metricNumber(result.result) },
      });
    },
    owner,
  );
}

async function collectTelegramChannelStats(config: BackendConfig): Promise<Record<string, number> | null> {
  if (!config.TELEGRAM_CHANNEL_STORIES_API_ID || !config.TELEGRAM_CHANNEL_STORIES_API_HASH || !config.TELEGRAM_CHANNEL_STORIES_SESSION)
    return null;
  const client = createChannelStoryClient(config);
  try {
    await withTimeout(client.connect(), 30_000, "telegram_profile_connect_timeout");
    const channel = await withTimeout(client.resolveChannel(`@${channelHandle(config)}`, true), 30_000, "telegram_profile_resolve_timeout");
    const stats = (await withTimeout(
      client.call({ _: "stats.getBroadcastStats", channel }),
      30_000,
      "telegram_profile_stats_timeout",
    )) as TelegramBroadcastStats;
    if (stats._ !== "stats.broadcastStats") throw new Error("Telegram returned an unexpected channel statistics response");
    return telegramChannelMetrics(stats);
  } finally {
    try {
      await withTimeout(client.destroy(), 5_000, "telegram_profile_destroy_timeout");
    } catch {
      // Metrics are already collected. A stalled process-local teardown must
      // not turn a successful provider read into a failed sync.
    }
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

async function syncThreadsProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch, owner?: string): Promise<void> {
  const token = config.THREADS_RU_ACCESS_TOKEN;
  if (!token) return;
  await synced(
    backendDb,
    "threads_profile",
    async () => {
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
    },
    owner,
  );
}
