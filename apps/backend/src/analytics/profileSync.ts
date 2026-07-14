import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { requestJson } from "../delivery/social/http.js";
import { youtubeAccessToken } from "../video/publishers.js";
import { markSynced, metricNumber, upsertProfile } from "./creatorStore.js";

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
    upsertProfile(backendDb, "youtube", {
      title: channelItem?.snippet?.title ?? "YouTube",
      subscriberCount: metricNumber(channelItem?.statistics?.subscriberCount),
      viewCount: metricNumber(channelItem?.statistics?.viewCount),
      videoCount: metricNumber(channelItem?.statistics?.videoCount),
      ...period,
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
    upsertProfile(backendDb, "instagram", {
      username: profileData.username ?? "Instagram",
      biography: profileData.biography ?? "",
      followersCount: metricNumber(profileData.followers_count),
      mediaCount: metricNumber(profileData.media_count),
    });
    markSynced(backendDb, "instagram");
  } catch (error) {
    markSynced(backendDb, "instagram", error instanceof Error ? error.message : String(error));
  }
}
