export type DashboardMetricName = "views" | "likes" | "replies" | "reposts";
export type ChartMetricName = Extract<DashboardMetricName, "views" | "likes" | "replies">;

export type TargetMetric = {
  value?: unknown;
  sampled_at?: string | null;
  source?: string | null;
  error?: string | null;
  raw?: unknown;
};

export type TargetRecord = {
  status?: string | null;
  ok?: boolean;
  external_id?: string | null;
  external_ids?: unknown;
  url?: string | null;
  error?: string | null;
  skipped?: boolean;
  updated_at?: string | null;
  raw?: unknown;
};

export type PipelinePost = {
  post_id?: number | string | null;
  message_id?: number | string | null;
  telegram_message_id?: number | string | null;
  post_key?: string | null;
  date?: string | null;
  date_msk?: string | null;
  text_ru?: string | null;
  text_en?: string | null;
  full_text_ru?: string | null;
  full_text_en?: string | null;
  media_json?: unknown;
  media_ru_json?: unknown;
  media_en_json?: unknown;
  slug_en?: string | null;
  slug_ru?: string | null;
  site_url?: string | null;
  telegram_url?: string | null;
  site_ru?: unknown;
  site_en?: unknown;
  targets?: Record<string, TargetRecord | undefined>;
  metrics?: Record<string, Record<string, TargetMetric | undefined> | undefined>;
};

export type PipelineData = {
  posts?: PipelinePost[];
  feed?: { items?: number | null };
  social_worker?: {
    processed_count?: number | null;
    last_update_id?: unknown;
  };
  updated_at?: string | null;
};

export type DashboardQueueDraft = {
  id?: number | string | null;
  status?: string | null;
  textRu?: string | null;
  scheduledAt?: string | null;
  scheduledEnAt?: string | null;
  channelMessageId?: string | number | null;
  updatedAt?: string | null;
};

export type DashboardQueueJob = {
  jobId?: string | number | null;
  postId?: string | number | null;
  messageId?: string | number | null;
  target?: string | null;
  status?: string | null;
  attemptCount?: number | null;
  publishAt?: string | null;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
};

export type DashboardCredential = {
  target?: string | null;
  status?: string | null;
  missingEnvJson?: string | null;
  lastError?: string | null;
  lastCheckedAt?: string | null;
};

export type DashboardMetricIssue = {
  messageId?: string | number | null;
  target?: string | null;
  status?: string | null;
  error?: string | null;
};

export type DashboardLifecycleRow = {
  postKey?: string | number | null;
  state?: string | null;
  reason?: string | null;
  updatedAt?: string | null;
};

export type OpsPayload = {
  drafts?: DashboardQueueDraft[];
  jobs?: DashboardQueueJob[];
  credentials?: DashboardCredential[];
  pipeline?: {
    metrics?: {
      recent?: DashboardMetricIssue[];
    };
  };
  lifecycle?: DashboardLifecycleRow[];
};
