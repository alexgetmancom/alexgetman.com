import type { BackendConfig } from "../../../foundation/config.js";
import { createChannelStoryClient } from "../../../foundation/external/telegram-session.js";
import { requestText } from "../../../foundation/http.js";
import { withTimeout } from "../../../foundation/runtime/timeout.js";
import type { MetricTask } from "../metric-schedule.js";
import { TerminalMetricError } from "./errors.js";
import type { MetricResult } from "./types.js";

const TELEGRAM_METRICS_TIMEOUT_MS = 4_000;

export async function collectTelegram(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const channel = config.TELEGRAM_CHANNEL_USERNAME.replace(/^@/, "");
  const messageId = task.externalId ?? telegramMessageIdFromUrl(task.url, channel);
  if (!messageId || !/^\d+$/.test(messageId)) throw new TerminalMetricError(`invalid_telegram_message_id:${messageId ?? "missing"}`);
  const html = await requestText(fetchImpl, `https://t.me/${channel}/${messageId}?embed=1&mode=tme`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; alexgetman-backend/1.0)" },
    signal: AbortSignal.timeout(TELEGRAM_METRICS_TIMEOUT_MS),
  });
  // `posts.message_id` is a local Studio reference for newly-created drafts.
  // The public channel URL and the metrics page use Delivery's external ID.
  const escaped = escapeRegExp(`${channel}/${messageId}`);
  const section = html.match(
    new RegExp(`data-post=["']${escaped}["'][\\s\\S]*?(?=data-post=["']${escapeRegExp(channel)}\\/|<\\/section>|$)`),
  )?.[0];
  if (!section) throw new TerminalMetricError("telegram_post_not_found");
  const views = parseCompactCount(section.match(/tgme_widget_message_views[^>]*>([^<]+)</)?.[1]);
  const reactions = [...section.matchAll(/class=["']tgme_reaction["'][^>]*>[\s\S]*?<\/i>([^<]+)/g)]
    .map((match) => parseCompactCount(match[1]) ?? 0)
    .reduce((sum, value) => sum + value, 0);
  if (views == null) throw new Error("telegram_views_not_found");
  return { metrics: { views, likes: reactions }, source: "t_me_public", raw: { message_id: Number(messageId) } };
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
  try {
    await withTimeout(instance.connect(), 30_000, "telegram_story_metrics_connect_timeout");
    const stories = await withTimeout(
      instance.getStoriesById(config.TELEGRAM_CHANNEL_USERNAME.replace(/^@/, ""), Number(task.externalId)),
      30_000,
      "telegram_story_metrics_read_timeout",
    );
    const story = stories[0];
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
    try {
      await withTimeout(instance.destroy(), 5_000, "telegram_story_metrics_destroy_timeout");
    } catch {
      // The read has already completed. Teardown belongs to this process, not
      // to the metric result, and the next cycle creates a fresh client.
    }
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

function telegramMessageIdFromUrl(value: string | null, channel: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.hostname !== "t.me" && url.hostname !== "www.t.me") return null;
    const match = url.pathname.match(new RegExp(`^/(?:s/)?${escapeRegExp(channel)}/(\\d+)/?$`));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
