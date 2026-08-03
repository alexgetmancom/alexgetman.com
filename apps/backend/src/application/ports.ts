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
  textEnApproved: string;
  textRuEntitiesJson: string;
  textEnEntitiesJson: string;
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
  storyCards: StoryCardQueue;
};
