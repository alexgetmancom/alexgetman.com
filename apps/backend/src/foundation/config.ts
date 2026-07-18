import * as z from "zod";
import { loadStudioConfig, type StudioConfig } from "../studio.js";

const booleanFlag = z
  .string()
  .optional()
  .transform((value) => value != null && !["0", "false", "no", "off"].includes(value.toLowerCase()));

const providerRouteSchema = z.object({
  provider: z.enum(["native", "zernio"]),
  accountId: z.string().min(1).optional(),
});

const providerRoutes = z
  .string()
  .default("{}")
  .transform((value, context) => {
    try {
      const routes = z.record(z.string(), providerRouteSchema).safeParse(JSON.parse(value));
      if (routes.success) return routes.data;
      context.addIssue({ code: "custom", message: "PUBLISH_PROVIDER_ROUTES_JSON must be an object of provider routes" });
    } catch {
      context.addIssue({ code: "custom", message: "PUBLISH_PROVIDER_ROUTES_JSON must be valid JSON" });
    }
    return z.NEVER;
  });

const envSchema = z
  .object({
    NODE_ENV: z.string().default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PORT: z.coerce.number().int().positive().default(8788),
    BIND_HOST: z.string().default("127.0.0.1"),
    DATA_DIR: z.string().default("/data"),
    STUDIO_CONFIG: z.string().default("studio.yaml"),
    PIPELINE_DB: z.string().default("/data/pipeline.db"),
    FEED_JSON: z.string().default("/data/feed.json"),
    SITE_METRICS_JSON: z.string().default("/data/metrics.json"),
    SITE_CONTENT_METRICS_JSON: z.string().default("/data/content-metrics.json"),
    TELEGRAM_API_BASE_URL: z.string().default("http://bot-api:8081"),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    CONTROLLER_BOT_TOKEN: z.string().optional(),
    TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
    WEBHOOK_PATH: z.string().default("/tg-feed/webhook"),
    LIKES_SALT: z.string().optional(),
    TRUSTED_CLIENT_IP_HEADER: z.enum(["x-real-ip", "cf-connecting-ip"]).optional(),
    PUBLIC_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
    PUBLIC_RATE_LIMIT_PAGEVIEWS: z.coerce.number().int().min(1).max(10_000).default(240),
    PUBLIC_RATE_LIMIT_LIKES: z.coerce.number().int().min(1).max(10_000).default(30),
    COMMAND_CENTER_TOKEN: z.string().optional(),
    COMMAND_CENTER_URL: z.string().default("https://alexgetman.com/command-center"),
    MCP_STUDIO_TOKEN: z.string().min(16).optional(),
    MCP_STUDIO_ACTOR_ID: z.coerce.number().int().positive().optional(),
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
    /** Refreshes account-level followers and aggregate platform insights. */
    CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .default(24 * 60 * 60),
    TELEGRAM_METRICS_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(10),
    MAX_METRIC_TASKS_PER_CYCLE: z.coerce.number().int().positive().default(30),
    OBSERVABILITY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
    ALERT_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(3600),
    IDLE_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(5),
    CONTROLLER_ALBUM_SETTLE_SECONDS: z.coerce.number().positive().default(4),
    PUBLISH_CLAIM_LIMIT: z.coerce.number().int().positive().default(20),
    PUBLISH_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4),
    // A provider call must not hold the complete queue loop forever. Timeouts
    // are terminal and require an explicit retry, because the provider may
    // have accepted the request while its response was lost.
    PUBLISH_JOB_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(3_600).default(240),
    PUBLISH_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
    PUBLISH_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
    PUBLISH_BACKOFF_BASE_SECONDS: z.coerce.number().int().positive().default(60),
    PUBLISH_BACKOFF_MAX_SECONDS: z.coerce.number().int().positive().default(3600),
    SITE_JOB_CLAIM_LIMIT: z.coerce.number().int().positive().default(20),
    SITE_JOB_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
    SITE_JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    SITE_JOB_BACKOFF_BASE_SECONDS: z.coerce.number().int().positive().default(60),
    SITE_JOB_BACKOFF_MAX_SECONDS: z.coerce.number().int().positive().default(900),
    FFMPEG_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
    FFMPEG_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(2),
    /** Where optional heavy media transforms execute. Remote workers are
     * deliberately opt-in so a stock self-hosted Studio keeps working. */
    MEDIA_PROCESSOR_PROVIDER: z.enum(["local", "remote_http"]).default("local"),
    MEDIA_PROCESSOR_URL: z.string().url().optional(),
    MEDIA_PROCESSOR_TOKEN: z.string().min(16).optional(),
    MEDIA_PROCESSOR_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(900),
    MEDIA_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    MEDIA_CACHE_DIR: z.string().default("/data/media-cache"),
    // Dedicated mounted media volume; never place large Studio assets on the
    // pipeline/database disk mounted at /data.
    STUDIO_MEDIA_DIR: z.string().default("/data/video-media"),
    STUDIO_MEDIA_MAX_BYTES: z.coerce.number().int().positive().max(2_000_000_000).default(1_000_000_000),
    VIDEO_MEDIA_DIR: z.string().default("/data/video-media"),
    VIDEO_MAX_BYTES: z.coerce.number().int().positive().max(2_000_000_000).default(1_000_000_000),
    // VIDEO_PREPARE_LEAD_MINUTES / VIDEO_REMINDER_MINUTES / VIDEO_MEDIA_RETENTION_HOURS
    // are owned by studio.yaml (see loadConfig); they are not env-configurable.
    SITE_PUBLIC_DIR: z.string().default("/data/site"),
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
    THREADS_RETRY_DELAY_MS: z.coerce.number().int().min(1).max(30_000).default(2_000),
    FACEBOOK_GRAPH_API_VERSION: z.string().default("v23.0"),
    FACEBOOK_PAGE_ACCESS_TOKEN: z.string().optional(),
    FACEBOOK_PAGE_ID: z.string().optional(),
    FACEBOOK_RU_PAGE_ACCESS_TOKEN: z.string().optional(),
    FACEBOOK_RU_PAGE_ID: z.string().optional(),
    LINKEDIN_ACCESS_TOKEN: z.string().optional(),
    LINKEDIN_AUTHOR_URN: z.string().optional(),
    LINKEDIN_API_VERSION: z.string().default("202606"),
    ENABLE_LINKEDIN_METRICS: booleanFlag.default(false),
    X_CONSUMER_KEY: z.string().optional(),
    X_CONSUMER_SECRET: z.string().optional(),
    X_ACCESS_TOKEN: z.string().optional(),
    X_ACCESS_TOKEN_SECRET: z.string().optional(),
    ENABLE_X_METRICS: booleanFlag.default(false),
    ENABLE_X_PROFILE_METRICS: booleanFlag.default(true),
    INSTAGRAM_ACCESS_TOKEN: z.string().optional(),
    INSTAGRAM_USER_ID: z.string().optional(),
    INSTAGRAM_EN_ACCESS_TOKEN: z.string().optional(),
    INSTAGRAM_EN_USER_ID: z.string().optional(),
    INSTAGRAM_RU_ACCESS_TOKEN: z.string().optional(),
    INSTAGRAM_RU_USER_ID: z.string().optional(),
    INSTAGRAM_GRAPH_API_VERSION: z.string().default("v23.0"),
    /** Per durable target route, e.g. {"instagram_reels":{"provider":"zernio","accountId":"..."}}. */
    PUBLISH_PROVIDER_ROUTES_JSON: providerRoutes,
    ZERNIO_API_KEY: z.string().min(16).optional(),
    YOUTUBE_CLIENT_ID: z.string().optional(),
    YOUTUBE_CLIENT_SECRET: z.string().optional(),
    YOUTUBE_REFRESH_TOKEN: z.string().optional(),
    ENABLE_INSTAGRAM_STORIES: booleanFlag.default(false),
    ENABLE_TELEGRAM_STORIES: booleanFlag.default(false),
    TELEGRAM_STORIES_CHANNEL: z.string().optional(),
    TELEGRAM_CHANNEL_STORIES_API_ID: z.coerce.number().int().positive().optional(),
    TELEGRAM_CHANNEL_STORIES_API_HASH: z.string().optional(),
    TELEGRAM_CHANNEL_STORIES_SESSION: z.string().optional(),
    REMOTE_MEDIA_PATH: z.string().default("/feed-data/media"),
    PUBLIC_MEDIA_BASE_URL: z.string().default("https://alexgetman.com/media"),
    TEMP_MEDIA_DIR: z.string().default("/tmp/alexgetman-media"),
    PUBLIC_BASE_URL: z.string().default("https://alexgetman.com"),
    DEPLOY_AGENT_URL: z.url().optional(),
    DEPLOY_AGENT_TOKEN: z.string().min(16).optional(),
    ENABLE_BOT_POLLING: booleanFlag.default(false),
    ENABLE_WORKERS: booleanFlag.default(true),
    INDEXNOW_ENABLED: booleanFlag.default(true),
  })
  .superRefine((env, context) => {
    if (env.ENABLE_TELEGRAM_STORIES) {
      for (const key of [
        "TELEGRAM_STORIES_CHANNEL",
        "TELEGRAM_CHANNEL_STORIES_API_ID",
        "TELEGRAM_CHANNEL_STORIES_API_HASH",
        "TELEGRAM_CHANNEL_STORIES_SESSION",
      ] as const) {
        if (!env[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required when ENABLE_TELEGRAM_STORIES=true` });
      }
    }
    if (env.ENABLE_INSTAGRAM_STORIES && (!env.INSTAGRAM_ACCESS_TOKEN || !env.INSTAGRAM_USER_ID)) {
      context.addIssue({
        code: "custom",
        path: ["INSTAGRAM_ACCESS_TOKEN"],
        message: "INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID are required when ENABLE_INSTAGRAM_STORIES=true",
      });
    }
    if (Boolean(env.DEPLOY_AGENT_URL) !== Boolean(env.DEPLOY_AGENT_TOKEN)) {
      context.addIssue({
        code: "custom",
        path: ["DEPLOY_AGENT_URL"],
        message: "DEPLOY_AGENT_URL and DEPLOY_AGENT_TOKEN must be configured together",
      });
    }
    if (Boolean(env.MCP_STUDIO_TOKEN) !== Boolean(env.MCP_STUDIO_ACTOR_ID)) {
      context.addIssue({
        code: "custom",
        path: ["MCP_STUDIO_TOKEN"],
        message: "MCP_STUDIO_TOKEN and MCP_STUDIO_ACTOR_ID must be configured together",
      });
    }
    if (env.MCP_STUDIO_ACTOR_ID && !env.ADMIN_IDS.includes(env.MCP_STUDIO_ACTOR_ID)) {
      context.addIssue({
        code: "custom",
        path: ["MCP_STUDIO_ACTOR_ID"],
        message: "MCP_STUDIO_ACTOR_ID must belong to ADMIN_IDS",
      });
    }
  });

export type BackendConfig = z.infer<typeof envSchema> & {
  VIDEO_PREPARE_LEAD_MINUTES: number;
  VIDEO_REMINDER_MINUTES: number;
  VIDEO_MEDIA_RETENTION_HOURS: number;
  TIMEZONE: string;
  TIMEZONE_LABEL: string;
  controllerBotToken: string | undefined;
  commandCenterToken: string | undefined;
  studio: StudioConfig;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const parsed = envSchema.parse({
    ...env,
    ADMIN_IDS: env.ADMIN_IDS ?? env.CONTROLLER_ADMIN_IDS,
  });
  if (parsed.NODE_ENV === "production") {
    if (!parsed.COMMAND_CENTER_TOKEN) throw new Error("COMMAND_CENTER_TOKEN is required in production");
    if (parsed.COMMAND_CENTER_TOKEN === parsed.TELEGRAM_WEBHOOK_SECRET)
      throw new Error("COMMAND_CENTER_TOKEN must be separate from TELEGRAM_WEBHOOK_SECRET in production");
  }
  const studio = loadStudioConfig(parsed.STUDIO_CONFIG);
  if (studio.modules.youtube && studio.modules.video_posting) {
    for (const key of ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"] as const) {
      if (!parsed[key]) throw new Error(`${key} is required when YouTube video publishing is enabled`);
    }
  }
  const instagramRoute = parsed.PUBLISH_PROVIDER_ROUTES_JSON.instagram_reels;
  if (studio.modules.instagram && studio.modules.video_posting) {
    if (instagramRoute?.provider === "zernio") {
      if (!parsed.ZERNIO_API_KEY || !instagramRoute.accountId)
        throw new Error("ZERNIO_API_KEY and instagram_reels.accountId are required when Zernio Instagram publishing is enabled");
    } else if (!parsed.INSTAGRAM_ACCESS_TOKEN || !parsed.INSTAGRAM_USER_ID) {
      throw new Error("INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID are required when Instagram video publishing is enabled");
    }
  }
  if (parsed.MEDIA_PROCESSOR_PROVIDER === "remote_http" && (!parsed.MEDIA_PROCESSOR_URL || !parsed.MEDIA_PROCESSOR_TOKEN)) {
    throw new Error("MEDIA_PROCESSOR_URL and MEDIA_PROCESSOR_TOKEN are required when MEDIA_PROCESSOR_PROVIDER=remote_http");
  }
  return {
    ...parsed,
    VIDEO_PREPARE_LEAD_MINUTES: studio.video.prepare_lead_minutes,
    VIDEO_REMINDER_MINUTES: studio.video.reminder_minutes,
    VIDEO_MEDIA_RETENTION_HOURS: studio.video.retention_hours,
    TIMEZONE: studio.timezone,
    TIMEZONE_LABEL: studio.timezoneLabel,
    controllerBotToken: parsed.CONTROLLER_BOT_TOKEN ?? parsed.TELEGRAM_BOT_TOKEN,
    commandCenterToken: parsed.COMMAND_CENTER_TOKEN ?? parsed.TELEGRAM_WEBHOOK_SECRET,
    studio,
  };
}
