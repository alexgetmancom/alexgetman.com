export type DomainEventInput = {
  ref?: string | null;
  type: string;
  severity: "info" | "warn" | "error";
  target?: string | null;
  message: string;
  details?: Record<string, unknown>;
  cooldownSeconds?: number;
};

/** A deterministic time boundary for application use cases and tests. */
export type Clock = { now(): Date };

/** Stable application representation of a draft. Database naming stays at the boundary. */
export type DraftRecord = {
  id: number;
  actor_id: number;
  status: string;
  text_ru: string;
  text_en_machine: string | null;
  text_en_approved: string | null;
  targets_json: string;
  media_ru_json: string | null;
  media_en_json: string | null;
  channel_message_id: number | null;
  scheduled_at: string | null;
  scheduled_en_at: string | null;
  post_id: number | null;
  text_ru_entities_json: string | null;
  text_en_entities_json: string | null;
  threads_chain_approved: number;
  story_publish_mode: string | null;
};

export type NewDraft = {
  actorId: number;
  textRu: string;
  textEnMachine: string;
  textEnApproved: string | null;
  targetsJson: string;
  mediaRuJson: string | null;
  textRuEntitiesJson: string;
};

export type DraftPatch = Partial<{
  textRu: string;
  textEnApproved: string | null;
  textRuEntitiesJson: string | null;
  textEnEntitiesJson: string | null;
  targetsJson: string;
  mediaRuJson: string | null;
  mediaEnJson: string | null;
  threadsChainApproved: number;
  updatedAt: string;
}>;

export type DraftSource = {
  id: number;
  draftId: number;
  url: string;
  labelRu: string;
  labelEn: string | null;
  displayKind: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type PostEventRecord = {
  id: number;
  postKey: string | null;
  eventType: string;
  severity: string;
  target: string | null;
  message: string;
  detailsJson: string | null;
  createdAt: string;
  ackedAt: string | null;
};

export type FailedPublicationTarget = {
  target: string;
  status: "failed" | "verification_required";
  error: string | null;
};

export type PublicationRetryResult = {
  target: string;
  outcome: "requeued" | "already_queued" | "not_failed";
};

export type DraftEntityCandidate = {
  kind: string;
  slug: string;
  titleRu: string;
  titleEn: string | null;
};

/** Post-specific persistence port used by Studio command and query use cases. */
export type StudioPostStore = {
  sources(draftId: number): DraftSource[];
  replaceSources(draftId: number, urls: string[], now: string): void;
  replaceEntityCandidates(draftId: number, candidates: DraftEntityCandidate[], now: string): void;
  acceptEntityCandidates(draftId: number, now: string): void;
  notificationSettings(actorIds: number[]): Array<{ actorId: number; remindersEnabled: number }>;
  history(draftId: number, postId: number | null, limit: number): PostEventRecord[];
  progress(draftId: number): StudioPostProgress | null;
  failedPublicationTargets(postId: number): FailedPublicationTarget[];
  retryPublicationTargets(postId: number, targets: string[]): PublicationRetryResult[];
};

/** Persistence projection used by the transport-neutral post progress read model. */
type StudioPostProgress = {
  draft: { id: number; actorId: number; postId: number | null; targetsJson: string };
  publishJobs: Array<{ target: string; status: string; lastError: string | null }>;
  siteJobs: Array<{ reason: string; status: string; lastError: string | null }>;
};

/** Queue projection used by every Studio interface. */
export type StudioQueueStore = {
  posts(actorIds: number[], limit: number): StudioQueuePost[];
  videos(actorIds: number[], limit: number): StudioQueueVideo[];
  failedPostIds(postIds: number[]): number[];
  failedStoryCardDraftIds(draftIds: number[]): number[];
  videoTargets(videoDraftIds: number[]): StudioQueueVideoTarget[];
  effectivePostTargets(targets: Record<string, boolean>): Record<string, boolean>;
};

export type StudioQueuePost = {
  id: number;
  actorId: number;
  status: string;
  textRu: string;
  targetsJson: string;
  updatedAt: string;
  scheduledAt: string | null;
  scheduledEnAt: string | null;
  postId: number | null;
};

export type StudioQueueVideo = {
  id: number;
  actorId: number;
  status: string;
  label: string;
  updatedAt: string;
};

export type StudioQueueVideoTarget = {
  videoDraftId: number;
  status: string;
  scheduledAt: string | null;
};

/** Durable notification persistence used by the transport-neutral Studio inbox. */
export type StudioNotificationStore = {
  unread(limit: number): PostEventRecord[];
  get(id: number): PostEventRecord | null;
  acknowledge(id: number, now: string): boolean;
  cancelQueuedReminders(actorId: number, now: string): number;
  draftOwner(draftId: number): number | null;
  videoOwner(videoDraftId: number): number | null;
  postIdForKey(postKey: string): number | null;
  postOwner(postId: number): number | null;
};

export type StudioSettingsStore = {
  notifications(actorId: number): StudioNotificationSettingsRecord | null;
  locale(actorId: number): string | null;
  weeklyDigest(): StudioWeeklyDigestSettingsRecord | null;
  saveWeeklyDigest(input: { enabled: number; weekday: number; updatedAt: string }): void;
  saveNotifications(input: {
    actorId: number;
    remindersEnabled: number;
    reminderMinutes: number;
    completionEnabled: number;
    updatedAt: string;
  }): void;
  botSettings(actorId: number): StudioBotSettingsRecord | null;
  saveBotSettings(input: { actorId: number; youtubeSignature: string; pendingAction: string | null; updatedAt: string }): void;
  saveLocale(input: { actorId: number; locale: string; updatedAt: string }): void;
};

type StudioNotificationSettingsRecord = {
  actorId: number;
  remindersEnabled: number;
  reminderMinutes: number;
  completionEnabled: number;
  updatedAt: string;
};

type StudioWeeklyDigestSettingsRecord = {
  id: number;
  enabled: number;
  weekday: number;
  updatedAt: string;
};

type StudioBotSettingsRecord = {
  actorId: number;
  youtubeSignature: string;
  pendingAction: string | null;
  updatedAt: string;
};

export type StudioMediaAssetRecord = {
  id: number;
  actorId: number;
  kind: string;
  mimeType: string;
  filename: string;
  localPath: string;
  byteSize: number;
  sha256: string;
  source: string;
  createdAt: string;
};

export type StudioMediaAssetStore = {
  findByOwnerHash(actorId: number, sha256: string): StudioMediaAssetRecord | null;
  insertIfAbsent(input: Omit<StudioMediaAssetRecord, "id">): StudioMediaAssetRecord | null;
  get(id: number): StudioMediaAssetRecord | null;
  list(actorIds: number[], limit: number): StudioMediaAssetRecord[];
  require(actorIds: number[], assetIds: number[]): StudioMediaAssetRecord[];
};

type StudioVideoDraftRecord = {
  id: number;
  actorId: number;
  locale: string;
  label: string;
  assetKey: string;
  studioMediaAssetId: number | null;
  status: string;
  scheduledAt: string | null;
  reminderSentAt: string | null;
  retentionUntil: string | null;
  sourcePrunedAt: string | null;
  controlChatId: number | null;
  controlMessageId: number | null;
  createdAt: string;
  updatedAt: string;
};

type StudioVideoTargetRecord = {
  id: number;
  videoDraftId: number;
  target: string;
  metadataJson: Record<string, unknown>;
  scheduledAt: string | null;
  status: string;
  deliveryProvider: string;
  providerAccountId: string | null;
  providerPostId: string | null;
  externalId: string | null;
  externalUrl: string | null;
  preparedAt: string | null;
  publishedAt: string | null;
  confirmationSource: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type StudioVideoJobRecord = {
  id: number;
  videoDraftId: number;
  videoTargetId: number | null;
  kind: string;
  runAt: string;
  status: string;
  reconcileAttemptCount: number;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  lockedBy: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Read-side video persistence used by Studio interfaces and previews. */
export type StudioVideoStore = {
  get(videoDraftId: number): StudioVideoDraftRecord | null;
  list(actorIds: number[], limit: number): StudioVideoDraftRecord[];
  targets(videoDraftId: number): StudioVideoTargetRecord[];
  jobs(videoDraftId: number): StudioVideoJobRecord[];
  history(postKey: string, limit: number): PostEventRecord[];
};

export type EntityEnrichmentStore = {
  locales(postId: number): Array<{ locale: string; text: string | null }>;
  entities(): Array<{ id: number; kind: string; parentEntityId: number | null; slug: string; titleRu: string; titleEn: string | null }>;
  aliases(): Array<{ entityId: number; alias: string }>;
  link(postId: number, entityId: number, linkRole: "focus" | "mention", createdAt: string): void;
};

export type ChannelConnectionRecord = {
  id: string;
  platform: string;
  locale: string;
  provider: string;
  providerAccountId: string | null;
  targetId: string | null;
  label: string;
  enabled: number;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type ChannelStore = {
  list(enabledOnly: boolean): ChannelConnectionRecord[];
  get(id: string): ChannelConnectionRecord | null;
  upsert(input: Omit<ChannelConnectionRecord, "createdAt" | "updatedAt">, now: string): void;
  disable(id: string, now: string): void;
  hasAny(): boolean;
  find(platform: string, locale: string): ChannelConnectionRecord | null;
  secrets(channelId: string): Array<{ name: string; valueEncrypted: string }>;
  saveSecret(input: { channelId: string; name: string; valueEncrypted: string; updatedAt: string }): void;
  deleteSecrets(channelId: string, name?: string): void;
  secretNames(channelId: string): string[];
};

/** Persistence port used by content and Studio use cases. */
export type DraftStore = {
  create(input: NewDraft): number;
  get(id: number): DraftRecord | null;
  list(actorIds: number[], limit: number): DraftRecord[];
  update(id: number, patch: DraftPatch): void;
};

/** Durable event port. Consumers can remain independent from the event table. */
export type EventStore = { record(input: DomainEventInput): boolean };

/** Story-card generation is a content side effect, not a database concern. */
export type StoryCardQueue = { queue(draftId: number): void };

/** Composition-root dependencies passed into application use cases. */
export type ApplicationPorts = {
  clock: Clock;
  drafts: DraftStore;
  events: EventStore;
  studioPosts: StudioPostStore;
  studioQueue: StudioQueueStore;
  studioNotifications: StudioNotificationStore;
  studioSettings: StudioSettingsStore;
  studioMediaAssets: StudioMediaAssetStore;
  studioVideos: StudioVideoStore;
  entityEnrichment: EntityEnrichmentStore;
  channels: ChannelStore;
  storyCards: StoryCardQueue;
};
