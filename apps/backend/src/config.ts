import "dotenv/config";
import * as z from "zod";

const booleanFlag = z
  .string()
  .optional()
  .transform((value) => value != null && !["0", "false", "no", "off"].includes(value.toLowerCase()));

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(8788),
  BIND_HOST: z.string().default("127.0.0.1"),
  DATA_DIR: z.string().default("/data"),
  PIPELINE_DB: z.string().default("/data/pipeline.db"),
  FEED_JSON: z.string().default("/feed-data/feed.json"),
  SITE_METRICS_JSON: z.string().default("/feed-data/metrics.json"),
  TELEGRAM_API_BASE_URL: z.string().default("http://bot-api:8081"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  CONTROLLER_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  WEBHOOK_PATH: z.string().default("/tg-feed/webhook"),
  LIKES_SALT: z.string().optional(),
  COMMAND_CENTER_TOKEN: z.string().optional(),
  COMMAND_CENTER_URL: z.string().default("https://alexgetman.com/command-center"),
  DEEPSEEK_API_KEY: z.string().optional(),
  ADMIN_IDS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  CONTROLLER_ADMIN_IDS: z.string().optional(),
  CHANNEL_USERNAME: z.string().default("alexgetmancom"),
  PIPELINE_BASELINE_MESSAGE_ID: z.coerce.number().int().default(422),
  METRICS_REFRESH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
  TELEGRAM_METRICS_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(10),
  MAX_METRIC_TASKS_PER_CYCLE: z.coerce.number().int().positive().default(30),
  OBSERVABILITY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  ALERT_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(3600),
  IDLE_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(5),
  CONTROLLER_ALBUM_SETTLE_SECONDS: z.coerce.number().positive().default(4),
  PUBLISH_CLAIM_LIMIT: z.coerce.number().int().positive().default(20),
  PUBLISH_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
  PUBLISH_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
  PUBLISH_BACKOFF_BASE_SECONDS: z.coerce.number().int().positive().default(60),
  PUBLISH_BACKOFF_MAX_SECONDS: z.coerce.number().int().positive().default(3600),
  SITE_JOB_CLAIM_LIMIT: z.coerce.number().int().positive().default(20),
  SITE_JOB_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
  SITE_JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  SITE_JOB_BACKOFF_BASE_SECONDS: z.coerce.number().int().positive().default(60),
  SITE_JOB_BACKOFF_MAX_SECONDS: z.coerce.number().int().positive().default(900),
  SITE_BUILD_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
  FFMPEG_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  FFMPEG_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(2),
  MEDIA_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  SITE_BUILD_COMMAND: z.string().optional(),
  SITE_PUBLIC_DIR: z.string().default("/site-public"),
  DEVTO_API_KEY: z.string().optional(),
  MASTODON_INSTANCE: z.string().optional(),
  MASTODON_ACCESS_TOKEN: z.string().optional(),
  BLUESKY_HANDLE: z.string().optional(),
  BLUESKY_APP_PASSWORD: z.string().optional(),
  GITHUB_DISCUSSIONS_TOKEN: z.string().optional(),
  GITHUB_DISCUSSIONS_REPO_ID: z.string().default("R_kgDOSJwPnQ"),
  GITHUB_DISCUSSIONS_CATEGORY_ID: z.string().default("DIC_kwDOSJwPnc4C-S2f"),
  THREADS_ACCESS_TOKEN: z.string().optional(),
  THREADS_EN_ACCESS_TOKEN: z.string().optional(),
  THREADS_METRICS: z.string().default("views,likes,replies,reposts,quotes"),
  THREADS_CONTAINER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
  FACEBOOK_GRAPH_API_VERSION: z.string().default("v23.0"),
  FACEBOOK_PAGE_ACCESS_TOKEN: z.string().optional(),
  FACEBOOK_PAGE_ID: z.string().optional(),
  FACEBOOK_RU_PAGE_ACCESS_TOKEN: z.string().optional(),
  FACEBOOK_RU_PAGE_ID: z.string().optional(),
  LINKEDIN_ACCESS_TOKEN: z.string().optional(),
  LINKEDIN_AUTHOR_URN: z.string().optional(),
  LINKEDIN_API_VERSION: z.string().default("202606"),
  X_CONSUMER_KEY: z.string().optional(),
  X_CONSUMER_SECRET: z.string().optional(),
  X_ACCESS_TOKEN: z.string().optional(),
  X_ACCESS_TOKEN_SECRET: z.string().optional(),
  INSTAGRAM_ACCESS_TOKEN: z.string().optional(),
  INSTAGRAM_USER_ID: z.string().optional(),
  INSTAGRAM_EN_ACCESS_TOKEN: z.string().optional(),
  INSTAGRAM_EN_USER_ID: z.string().optional(),
  INSTAGRAM_RU_ACCESS_TOKEN: z.string().optional(),
  INSTAGRAM_RU_USER_ID: z.string().optional(),
  INSTAGRAM_GRAPH_API_VERSION: z.string().default("v23.0"),
  ENABLE_INSTAGRAM_STORIES: booleanFlag.default("false"),
  ENABLE_TELEGRAM_STORIES: booleanFlag.default("false"),
  TELEGRAM_STORIES_CHANNEL: z.string().optional(),
  TELEGRAM_STORIES_BOT_TOKEN: z.string().optional(),
  TELEGRAM_STORIES_BUSINESS_CONNECTION_ID: z.string().optional(),
  TELEGRAM_CHANNEL_STORIES_API_ID: z.coerce.number().int().positive().optional(),
  TELEGRAM_CHANNEL_STORIES_API_HASH: z.string().optional(),
  TELEGRAM_CHANNEL_STORIES_SESSION: z.string().optional(),
  REMOTE_MEDIA_PATH: z.string().default("/feed-data/media"),
  PUBLIC_MEDIA_BASE_URL: z.string().default("https://alexgetman.com/media"),
  TEMP_MEDIA_DIR: z.string().default("/tmp/alexgetman-media"),
  PUBLIC_BASE_URL: z.string().default("https://alexgetman.com"),
  ENABLE_BOT_POLLING: booleanFlag.default("false"),
  ENABLE_WORKERS: booleanFlag.default("true"),
  ENABLE_SITE_WORKER: booleanFlag.default("true"),
  INDEXNOW_ENABLED: booleanFlag.default("true"),
});

export type BackendConfig = z.infer<typeof envSchema> & {
  controllerBotToken: string | undefined;
  commandCenterToken: string | undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const parsed = envSchema.parse({
    ...env,
    ADMIN_IDS: env.ADMIN_IDS ?? env.CONTROLLER_ADMIN_IDS,
  });
  return {
    ...parsed,
    controllerBotToken: parsed.CONTROLLER_BOT_TOKEN ?? parsed.TELEGRAM_BOT_TOKEN,
    commandCenterToken: parsed.COMMAND_CENTER_TOKEN ?? parsed.TELEGRAM_WEBHOOK_SECRET,
  };
}
