import * as z from "zod";
import { loadStudioConfig, type StudioConfig } from "../studio.js";

/** Env flags arrive as strings, so the default has to be a string too: a boolean
 * default would be handed to the transform below on any Zod version that does
 * not short-circuit `undefined`, and `true.toLowerCase()` throws at startup. */
const booleanFlag = (fallback: boolean) =>
  z
    .string()
    .default(fallback ? "1" : "0")
    .transform((value) => !["0", "false", "no", "off"].includes(value.toLowerCase()));

/** An .env file states a key it has no value for by leaving it empty, and Docker
 * passes that through as "". Without this, every `KEY=` line in the shipped
 * .env.example reaches an `.optional()` field as a present-but-invalid value and
 * the container refuses to start — which is exactly what a fresh install is. */
function blankAsUnset(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value?.trim() !== ""));
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DEPLOYMENT_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PORT: z.coerce.number().int().positive().default(8788),
    BIND_HOST: z.string().default("127.0.0.1"),
    DATA_DIR: z.string().default("/data"),
    STUDIO_CONFIG: z.string().default("studio.yaml"),
    PIPELINE_DB: z.string().default("/data/pipeline.db"),
    // Telegram's own API. A deployment that runs a local Bot API server — the
    // way to lift the 50 MB download limit for video — points this at it
    // instead; the default must work for an install that does not.
    TELEGRAM_API_BASE_URL: z.string().default("https://api.telegram.org"),
    CONTROLLER_BOT_TOKEN: z.string().optional(),
    CLIENT_IP_HASH_SALT: z.string().min(16).default("development-only"),
    // Defaulted, not optional: the host proxy sets X-Real-IP on every route, and
    // when this was unset the whole internet collapsed onto one visitor identity
    // (see engagement/identity.ts), making the public rate limit one global budget.
    TRUSTED_CLIENT_IP_HEADER: z.enum(["x-real-ip", "cf-connecting-ip"]).default("x-real-ip"),
    COMMAND_CENTER_TOKEN: z.string().optional(),
    MCP_STUDIO_TOKEN: z.string().min(16).optional(),
    MCP_STUDIO_ACTOR_ID: z.coerce.number().int().positive().optional(),
    DEEPSEEK_API_KEY: z.string().optional(),
    /** Moscow hour at which the editor receives one AI-generated opportunity inbox. */
    EDITORIAL_INBOX_HOUR_MSK: z.coerce.number().int().min(0).max(23).default(10),
    GROK_CLI_PATH: z.string().default("grok"),
    GROK_CLI_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(3_600).default(900),
    CONTROLLER_ADMIN_IDS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((part) => Number(part.trim()))
          .filter((value) => Number.isSafeInteger(value) && value > 0),
      ),
    /** Leaving the Studio roster unset uses the Telegram controller roster.
     * Setting it lets Studio own work without granting Telegram access. */
    STUDIO_ACTOR_IDS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((part) => Number(part.trim()))
          .filter((value) => Number.isSafeInteger(value) && value > 0),
      ),
    // Empty means this Studio has no Telegram channel, which is a Studio that
    // serves only its website. It used to default to a real, live channel, and
    // the production guard below existed to stop a second Studio publishing
    // into the first one's audience. Removing the default removes the hazard,
    // and with it the requirement that every install name a channel.
    TELEGRAM_CHANNEL_USERNAME: z.string().default(""),
    METRICS_REFRESH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
    /** Refreshes account-level followers and aggregate platform insights. */
    CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .default(60 * 60),
    // The public t.me page answers in about 90ms or not at all, and a failed
    // check simply returns in 15 minutes. Ten seconds of waiting bought nothing
    // and dominated the average collection time.
    MAX_METRIC_TASKS_PER_CYCLE: z.coerce.number().int().positive().default(30),
    METRIC_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
    OBSERVABILITY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
    ALERT_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(3600),
    WORKER_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
    IDLE_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(5),
    // Refuse material post edits shortly before delivery so one locale cannot
    // silently publish the old payload while another publishes the new one.
    POST_EDIT_LOCK_MINUTES: z.coerce.number().int().min(1).max(60).default(2),
    CONTROLLER_ALBUM_SETTLE_SECONDS: z.coerce.number().positive().default(4),
    // A provider call must not hold the complete queue loop forever. Timeouts
    // are terminal and require an explicit retry, because the provider may
    // have accepted the request while its response was lost.
    PUBLISH_JOB_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(3_600).default(600),
    PUBLISH_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
    // Social publish jobs heartbeat (see publish-workflow.ts's withJobHeartbeat)
    // while a slow provider call is in flight, touching lockedAt so
    // recoverStalePublishJobs doesn't mistake "still working" for "worker crashed".
    PUBLISH_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(180),
    // Initial delivery plus three exponential-backoff retries.
    PUBLISH_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
    PUBLISH_BACKOFF_BASE_SECONDS: z.coerce.number().int().positive().default(60),
    PUBLISH_BACKOFF_MAX_SECONDS: z.coerce.number().int().positive().default(3600),
    FFMPEG_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
    /** Where optional heavy media transforms execute. Remote workers are
     * deliberately opt-in so a stock self-hosted Studio keeps working. */
    MEDIA_PROCESSOR_PROVIDER: z.enum(["local", "remote_http"]).default("local"),
    MEDIA_PROCESSOR_URL: z.url().optional(),
    MEDIA_PROCESSOR_TOKEN: z.string().min(16).optional(),
    MEDIA_PROCESSOR_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(900),
    MEDIA_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    MEDIA_CACHE_DIR: z.string().default("/data/media-cache"),
    STORY_CARD_DIR: z.string().default("/data/story-cards"),
    STORY_CARD_ASSETS_DIR: z.string().default("/app/apps/backend/assets/story-card"),
    STORY_CARD_RENDERER_ENTRY: z.string().default("/app/story-renderer/renderer-process.js"),
    STORY_CARD_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(60).default(15),
    STORY_CARD_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    // Dedicated mounted media volume; never place large Studio assets on the
    // pipeline/database disk mounted at /data.
    STUDIO_MEDIA_DIR: z.string().default("/data/video-media"),
    STUDIO_MEDIA_MAX_BYTES: z.coerce.number().int().positive().max(2_000_000_000).default(1_000_000_000),
    VIDEO_MEDIA_DIR: z.string().default("/data/video-media"),
    VIDEO_MAX_BYTES: z.coerce.number().int().positive().max(2_000_000_000).default(1_000_000_000),
    // Video jobs heartbeat (see video-worker.ts's withJobHeartbeat) at a tighter
    // interval than the social pipeline, so this lock timeout only has to be a
    // few missed heartbeats wide to safely detect a crash.
    VIDEO_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
    // How many times reconciliation may ask a provider whether an ambiguous
    // publication exists before it stops polling and waits for an operator.
    // Higher than the publish budget on purpose: these are reads, and a
    // platform can take a while to expose a freshly created object.
    RECONCILE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
    // VIDEO_PREPARE_LEAD_MINUTES / VIDEO_REMINDER_MINUTES / VIDEO_MEDIA_RETENTION_HOURS
    // are owned by studio.yaml (see loadConfig); they are not env-configurable.
    SITE_PUBLIC_DIR: z.string().default("/data/site"),
    THREADS_RU_ACCESS_TOKEN: z.string().optional(),
    THREADS_EN_ACCESS_TOKEN: z.string().optional(),
    THREADS_CONTAINER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
    THREADS_RETRY_DELAY_MS: z.coerce.number().int().min(1).max(30_000).default(2_000),
    X_CONSUMER_KEY: z.string().optional(),
    X_CONSUMER_SECRET: z.string().optional(),
    X_ACCESS_TOKEN: z.string().optional(),
    X_ACCESS_TOKEN_SECRET: z.string().optional(),
    ENABLE_X_METRICS: booleanFlag(false),
    DISCORD_BOT_TOKEN: z.string().optional(),
    DISCORD_CHANNEL_ID: z.string().optional(),
    // Only used to build the message permalink: the create-message response
    // carries the channel but not the guild it lives in.
    DISCORD_GUILD_ID: z.string().optional(),
    ENABLE_X_PROFILE_METRICS: booleanFlag(true),
    INSTAGRAM_EN_ACCESS_TOKEN: z.string().optional(),
    INSTAGRAM_EN_USER_ID: z.string().optional(),
    INSTAGRAM_RU_ACCESS_TOKEN: z.string().optional(),
    INSTAGRAM_RU_USER_ID: z.string().optional(),
    INSTAGRAM_GRAPH_API_VERSION: z.string().default("v23.0"),
    ZERNIO_API_KEY: z.string().min(16).optional(),
    YOUTUBE_RU_CLIENT_ID: z.string().optional(),
    YOUTUBE_RU_CLIENT_SECRET: z.string().optional(),
    YOUTUBE_RU_REFRESH_TOKEN: z.string().optional(),
    YOUTUBE_EN_CLIENT_ID: z.string().optional(),
    YOUTUBE_EN_CLIENT_SECRET: z.string().optional(),
    YOUTUBE_EN_REFRESH_TOKEN: z.string().optional(),
    TELEGRAM_STORIES_CHANNEL: z.string().optional(),
    TELEGRAM_CHANNEL_STORIES_API_ID: z.coerce.number().int().positive().optional(),
    TELEGRAM_CHANNEL_STORIES_API_HASH: z.string().optional(),
    TELEGRAM_CHANNEL_STORIES_SESSION: z.string().optional(),
    REMOTE_MEDIA_PATH: z.string().default("/feed-data/media"),
    // Only Studios that hand a platform a fetchable media URL set this. It is
    // optional rather than defaulted because a default here is someone else's
    // domain, and it is resolved against PUBLIC_BASE_URL below.
    PUBLIC_MEDIA_BASE_URL: z.string().optional(),
    PUBLIC_BASE_URL: z.string().default("https://alexgetman.com"),
    DEPLOY_AGENT_URL: z.url().optional(),
    DEPLOY_AGENT_TOKEN: z.string().min(16).optional(),
    INDEXNOW_ENABLED: booleanFlag(true),
  })
  .superRefine((env, context) => {
    const englishYouTube = [env.YOUTUBE_EN_CLIENT_ID, env.YOUTUBE_EN_CLIENT_SECRET, env.YOUTUBE_EN_REFRESH_TOKEN];
    if (englishYouTube.some(Boolean) && !englishYouTube.every(Boolean)) {
      context.addIssue({
        code: "custom",
        path: ["YOUTUBE_EN_CLIENT_ID"],
        message: "YOUTUBE_EN_CLIENT_ID, YOUTUBE_EN_CLIENT_SECRET and YOUTUBE_EN_REFRESH_TOKEN must be configured together",
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
    // Heartbeat/lock/timeout values are only meaningful in relation to each
    // other, and every field-level check above passes on a combination that
    // makes the watchdog steal jobs from a worker that is still running.
    for (const [heartbeatKey, lockKey] of [["PUBLISH_HEARTBEAT_INTERVAL_SECONDS", "PUBLISH_LOCK_TIMEOUT_SECONDS"]] as const) {
      // Two missed heartbeats must still fit inside the lock window; at exactly
      // one interval, ordinary scheduling jitter is enough to expire the lock.
      if (env[heartbeatKey] * 2 >= env[lockKey]) {
        context.addIssue({
          code: "custom",
          path: [heartbeatKey],
          message: `${heartbeatKey} (${env[heartbeatKey]}s) must be less than half of ${lockKey} (${env[lockKey]}s), or the watchdog can reclaim a job that is still running`,
        });
      }
    }
    // A provider call may legitimately occupy a worker for the whole job
    // timeout; the lock has to outlive it or the same job gets picked up twice.
    if (env.PUBLISH_JOB_TIMEOUT_SECONDS >= env.PUBLISH_LOCK_TIMEOUT_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["PUBLISH_JOB_TIMEOUT_SECONDS"],
        message: `PUBLISH_JOB_TIMEOUT_SECONDS (${env.PUBLISH_JOB_TIMEOUT_SECONDS}s) must be shorter than PUBLISH_LOCK_TIMEOUT_SECONDS (${env.PUBLISH_LOCK_TIMEOUT_SECONDS}s)`,
      });
    }
    // The MCP token authorizes an actor, so that actor has to be on the roster.
    // It is not required to be a Telegram admin: a deployment that lists
    // STUDIO_ACTOR_IDS can run the Studio with the bot switched off entirely.
    const roster = env.STUDIO_ACTOR_IDS.length > 0 ? env.STUDIO_ACTOR_IDS : env.CONTROLLER_ADMIN_IDS;
    if (env.MCP_STUDIO_ACTOR_ID && !roster.includes(env.MCP_STUDIO_ACTOR_ID)) {
      context.addIssue({
        code: "custom",
        path: ["MCP_STUDIO_ACTOR_ID"],
        message: "MCP_STUDIO_ACTOR_ID must belong to STUDIO_ACTOR_IDS (or CONTROLLER_ADMIN_IDS when that is the roster)",
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
  /** Where this Studio's dashboard lives. Derived, never configured: it is
   * PUBLIC_BASE_URL with one fixed path, and two settings for one address drift
   * into a same-origin check that rejects the real login form. */
  COMMAND_CENTER_URL: string;
  /** Resolved against PUBLIC_BASE_URL when this Studio does not serve its media
   * from a separate location. */
  PUBLIC_MEDIA_BASE_URL: string;
  studio: StudioConfig;
};

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): BackendConfig {
  const env = blankAsUnset(rawEnv);
  const parsed = envSchema.parse(env);
  if (parsed.NODE_ENV === "production" && parsed.DEPLOYMENT_ENV !== "production")
    throw new Error("DEPLOYMENT_ENV=production is required when NODE_ENV=production");
  if (parsed.DEPLOYMENT_ENV === "production" && parsed.NODE_ENV !== "production")
    throw new Error("NODE_ENV=production is required when DEPLOYMENT_ENV=production");
  if (parsed.DEPLOYMENT_ENV === "production") {
    if (!parsed.COMMAND_CENTER_TOKEN) throw new Error("COMMAND_CENTER_TOKEN is required in production");
    if (!env.CLIENT_IP_HASH_SALT) throw new Error("CLIENT_IP_HASH_SALT is required in production");
  }
  const studio = loadStudioConfig(parsed.STUDIO_CONFIG);
  // Same hazard, different surface: the default is a live site, so a Studio
  // that does not name its own would put the first one's domain in its feeds,
  // its sitemap and its canonical URLs.
  if (parsed.NODE_ENV === "production" && !env.PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL must be set explicitly in production");
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
    controllerBotToken: parsed.CONTROLLER_BOT_TOKEN,
    commandCenterToken: parsed.COMMAND_CENTER_TOKEN,
    COMMAND_CENTER_URL: `${parsed.PUBLIC_BASE_URL.replace(/\/$/, "")}/command-center`,
    PUBLIC_MEDIA_BASE_URL: parsed.PUBLIC_MEDIA_BASE_URL ?? `${parsed.PUBLIC_BASE_URL.replace(/\/$/, "")}/media`,
    studio,
  };
}
