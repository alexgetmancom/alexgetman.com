import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const publishJobs = sqliteTable(
  "publish_jobs",
  {
    jobId: integer("job_id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id"),
    postKey: text("post_key"),
    messageId: integer("message_id").notNull(),
    target: text("target").notNull(),
    status: text("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    publishAt: text("publish_at"),
    nextAttemptAt: text("next_attempt_at"),
    lockedBy: text("locked_by"),
    lockedAt: text("locked_at"),
    payloadJson: text("payload_json"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    messageTargetStatus: uniqueIndex("idx_publish_jobs_message_target_status").on(table.messageId, table.target, table.status),
    due: index("idx_publish_jobs_due").on(table.status, table.publishAt, table.nextAttemptAt, table.createdAt),
    lock: index("idx_publish_jobs_lock").on(table.lockedBy, table.lockedAt),
    post: index("idx_publish_jobs_post").on(table.postId, table.target, table.status),
  }),
);

export const workerState = sqliteTable("worker_state", {
  name: text("name").primaryKey(),
  stateJson: text("state_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const publishPlans = sqliteTable("publish_plans", {
  messageId: integer("message_id").primaryKey(),
  planJson: text("plan_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const siteSourceItems = sqliteTable("site_source_items", {
  messageId: integer("message_id").primaryKey(),
  itemJson: text("item_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const publicationPlans = sqliteTable("publication_plans", {
  postId: integer("post_id").primaryKey(),
  planJson: text("plan_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const publicationSources = sqliteTable("publication_sources", {
  postId: integer("post_id").primaryKey(),
  itemJson: text("item_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const postEvents = sqliteTable(
  "post_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postKey: text("post_key"),
    eventType: text("event_type").notNull().default("ops.event"),
    severity: text("severity").notNull().default("info"),
    target: text("target"),
    message: text("message").notNull(),
    detailsJson: text("details_json"),
    createdAt: text("created_at").notNull(),
    ackedAt: text("acked_at"),
  },
  (table) => ({
    lookup: index("idx_post_events_lookup").on(table.postKey, table.target, table.createdAt),
  }),
);

export const opsActions = sqliteTable("ops_actions", {
  actionId: integer("action_id").primaryKey({ autoIncrement: true }),
  actorType: text("actor_type").notNull(),
  action: text("action").notNull(),
  messageId: integer("message_id"),
  target: text("target"),
  status: text("status").notNull(),
  detailsJson: text("details_json"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

export const siteJobs = sqliteTable(
  "site_jobs",
  {
    jobId: integer("job_id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id"),
    messageId: integer("message_id").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at"),
    lockedBy: text("locked_by"),
    lockedAt: text("locked_at"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    due: index("idx_site_jobs_due").on(table.status, table.nextAttemptAt, table.createdAt),
    lock: index("idx_site_jobs_lock").on(table.lockedBy, table.lockedAt),
    post: index("idx_site_jobs_post").on(table.postId, table.status),
  }),
);

export const posts = sqliteTable("posts", {
  postKey: text("post_key").primaryKey(),
  postId: integer("post_id"),
  source: text("source").notNull().default("telegram"),
  channel: text("channel").notNull(),
  chatId: text("chat_id"),
  messageId: integer("message_id").notNull(),
  dateUtc: text("date_utc"),
  dateMsk: text("date_msk"),
  text: text("text"),
  textEn: text("text_en"),
  html: text("html"),
  htmlEn: text("html_en"),
  mediaJson: text("media_json"),
  mediaCount: integer("media_count").notNull().default(0),
  mediaTypesJson: text("media_types_json"),
  siteRuPath: text("site_ru_path"),
  siteEnPath: text("site_en_path"),
  telegramUrl: text("telegram_url"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  rawJson: text("raw_json"),
});

export const publications = sqliteTable("publications", {
  postId: integer("post_id").primaryKey({ autoIncrement: true }),
  draftId: integer("draft_id"),
  status: text("status").notNull().default("draft"),
  telegramMessageId: integer("telegram_message_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const postLocales = sqliteTable(
  "post_locales",
  {
    postId: integer("post_id").notNull(),
    locale: text("locale").notNull(),
    slug: text("slug").notNull(),
    text: text("text"),
    html: text("html"),
    entitiesJson: text("entities_json"),
    mediaJson: text("media_json"),
    siteEnabled: integer("site_enabled").notNull().default(0),
    publishedAt: text("published_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.postId, table.locale] }) }),
);

export const postTargets = sqliteTable(
  "post_targets",
  {
    postKey: text("post_key").notNull(),
    target: text("target").notNull(),
    status: text("status").notNull().default("unknown"),
    externalId: text("external_id"),
    externalIdsJson: text("external_ids_json"),
    url: text("url"),
    error: text("error"),
    skipped: integer("skipped").notNull().default(0),
    publishedAt: text("published_at"),
    updatedAt: text("updated_at").notNull(),
    rawJson: text("raw_json"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.postKey, table.target] }),
  }),
);

export const postMetrics = sqliteTable(
  "post_metrics",
  {
    postKey: text("post_key").notNull(),
    target: text("target").notNull(),
    metricName: text("metric_name").notNull().default("views"),
    value: integer("value"),
    unit: text("unit").notNull().default("count"),
    source: text("source"),
    sampledAt: text("sampled_at"),
    error: text("error"),
    rawJson: text("raw_json"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.postKey, table.target, table.metricName] }),
  }),
);

export const metricSamples = sqliteTable(
  "metric_samples",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postKey: text("post_key").notNull(),
    target: text("target").notNull(),
    metricName: text("metric_name").notNull().default("views"),
    value: integer("value"),
    sampledAt: text("sampled_at").notNull(),
    source: text("source"),
    rawJson: text("raw_json"),
  },
  (table) => ({
    lookup: index("idx_metric_samples_lookup").on(table.postKey, table.target, table.metricName, table.sampledAt),
  }),
);

export const metricSchedule = sqliteTable(
  "metric_schedule",
  {
    postKey: text("post_key").notNull(),
    target: text("target").notNull(),
    nextCheckAt: text("next_check_at"),
    lastCheckedAt: text("last_checked_at"),
    checkCount: integer("check_count").notNull().default(0),
    frozenAt: text("frozen_at"),
    lastError: text("last_error"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.postKey, table.target] }),
  }),
);

export const drafts = sqliteTable("drafts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  adminId: integer("admin_id").notNull(),
  status: text("status").notNull(),
  textRu: text("text_ru").notNull(),
  textEnMachine: text("text_en_machine"),
  textEnApproved: text("text_en_approved"),
  targetsJson: text("targets_json").notNull(),
  mediaRuJson: text("media_ru_json"),
  mediaEnJson: text("media_en_json"),
  channelMessageId: integer("channel_message_id"),
  scheduledAt: text("scheduled_at"),
  scheduledEnAt: text("scheduled_en_at"),
  publishMode: text("publish_mode"),
  postId: integer("post_id"),
  textRuEntitiesJson: text("text_ru_entities_json"),
  textEnEntitiesJson: text("text_en_entities_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const adminState = sqliteTable("admin_state", {
  adminId: integer("admin_id").primaryKey(),
  action: text("action"),
  draftId: integer("draft_id"),
  updatedAt: text("updated_at").notNull(),
});

export const pendingAlbums = sqliteTable("pending_albums", {
  id: text("id").primaryKey(),
  adminId: integer("admin_id").notNull(),
  chatId: integer("chat_id").notNull(),
  mediaGroupId: text("media_group_id").notNull(),
  action: text("action"),
  draftId: integer("draft_id"),
  textRu: text("text_ru").notNull().default(""),
  textEntitiesJson: text("text_entities_json"),
  mediaJson: text("media_json").notNull(),
  notified: integer("notified").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const postLifecycle = sqliteTable("post_lifecycle", {
  postKey: text("post_key").primaryKey(),
  state: text("state").notNull(),
  previousState: text("previous_state"),
  enteredAt: text("entered_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  reason: text("reason"),
  rawJson: text("raw_json"),
});

export const mediaAssets = sqliteTable("media_assets", {
  assetKey: text("asset_key").primaryKey(),
  postKey: text("post_key"),
  draftId: integer("draft_id"),
  locale: text("locale").notNull().default("ru"),
  role: text("role").notNull().default("original"),
  mediaType: text("media_type"),
  fileId: text("file_id"),
  sourcePath: text("source_path"),
  publicUrl: text("public_url"),
  sha256: text("sha256"),
  sizeBytes: integer("size_bytes"),
  width: integer("width"),
  height: integer("height"),
  durationSeconds: real("duration_seconds"),
  variantOf: text("variant_of"),
  status: text("status").notNull().default("known"),
  detailsJson: text("details_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const platformRules = sqliteTable(
  "platform_rules",
  {
    target: text("target").notNull(),
    formatKey: text("format_key").notNull(),
    supportStatus: text("support_status").notNull().default("unknown"),
    maxItems: integer("max_items"),
    notes: text("notes"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.target, table.formatKey] }) }),
);

export const platformCapabilities = sqliteTable(
  "platform_capabilities",
  {
    target: text("target").notNull(),
    formatKey: text("format_key").notNull(),
    status: text("status").notNull().default("unknown"),
    evidenceTestId: text("evidence_test_id"),
    evidenceMessageId: integer("evidence_message_id"),
    evidenceUrl: text("evidence_url"),
    notes: text("notes"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.target, table.formatKey] }) }),
);

export const credentialChecks = sqliteTable("credential_checks", {
  target: text("target").primaryKey(),
  status: text("status").notNull(),
  requiredEnvJson: text("required_env_json").notNull(),
  missingEnvJson: text("missing_env_json").notNull(),
  expiresAt: text("expires_at"),
  lastCheckedAt: text("last_checked_at").notNull(),
  nextCheckAt: text("next_check_at"),
  lastError: text("last_error"),
  detailsJson: text("details_json"),
});

export const contentMemory = sqliteTable("content_memory", {
  postKey: text("post_key").primaryKey(),
  messageId: integer("message_id"),
  lang: text("lang").notNull().default("mixed"),
  title: text("title"),
  summary: text("summary"),
  topicsJson: text("topics_json"),
  entitiesJson: text("entities_json"),
  sourceUrlsJson: text("source_urls_json"),
  performanceJson: text("performance_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const analyticsRollups = sqliteTable("analytics_rollups", {
  rollupKey: text("rollup_key").primaryKey(),
  scope: text("scope").notNull(),
  subject: text("subject").notNull(),
  metricJson: text("metric_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const deploymentSnapshots = sqliteTable("deployment_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gitSha: text("git_sha"),
  action: text("action").notNull(),
  status: text("status").notNull(),
  backupPath: text("backup_path"),
  detailsJson: text("details_json"),
  createdAt: text("created_at").notNull(),
});

export const alertDedup = sqliteTable("alert_dedup", {
  alertKey: text("alert_key").primaryKey(),
  lastSentAt: text("last_sent_at").notNull(),
  suppressedCount: integer("suppressed_count").notNull().default(0),
});

export const maintenanceLocks = sqliteTable("maintenance_locks", {
  name: text("name").primaryKey(),
  owner: text("owner").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const mediaTestCases = sqliteTable("media_test_cases", {
  testId: text("test_id").primaryKey(),
  formatKey: text("format_key").notNull(),
  title: text("title").notNull(),
  inputRecipe: text("input_recipe").notNull(),
  expectedTargetsJson: text("expected_targets_json").notNull(),
  status: text("status").notNull().default("pending"),
  lastMessageId: integer("last_message_id"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const mediaTestResults = sqliteTable(
  "media_test_results",
  {
    testId: text("test_id").notNull(),
    target: text("target").notNull(),
    messageId: integer("message_id").notNull(),
    status: text("status").notNull(),
    externalId: text("external_id"),
    url: text("url"),
    error: text("error"),
    notes: text("notes"),
    rawJson: text("raw_json"),
    checkedAt: text("checked_at").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.testId, table.target, table.messageId] }) }),
);

export const likes = sqliteTable(
  "likes",
  {
    postId: text("post_id").notNull(),
    ipHash: text("ip_hash").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({ pk: primaryKey({ columns: [table.postId, table.ipHash] }) }),
);
