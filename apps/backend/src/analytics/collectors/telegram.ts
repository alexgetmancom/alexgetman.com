import { requestText } from "../../delivery/social/http.js";
import { createChannelStoryClient } from "../../delivery/social/telegramSession.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { MetricTask } from "../metric-schedule.js";
import { TerminalMetricError } from "./errors.js";
import type { MetricResult } from "./types.js";

export async function collectTelegram(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
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

export async function collectTelegramStory(task: MetricTask, config: BackendConfig): Promise<MetricResult> {
  if (
    !config.TELEGRAM_CHANNEL_STORIES_API_ID ||
    !config.TELEGRAM_CHANNEL_STORIES_API_HASH ||
    !config.TELEGRAM_CHANNEL_STORIES_SESSION ||
    !task.externalId
  )
    throw new Error("missing_telegram_story_credentials_or_id");
  if (!/^\d+$/.test(task.externalId)) throw new TerminalMetricError(`invalid_telegram_story_id:${task.externalId}`);
  const instance = createChannelStoryClient(config);
  await instance.connect();
  try {
    const story = (await instance.getStoriesById(config.CHANNEL_USERNAME.replace(/^@/, ""), Number(task.externalId)))[0];
    if (!story) throw new TerminalMetricError(`telegram_story_not_found:${task.externalId}`);
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
