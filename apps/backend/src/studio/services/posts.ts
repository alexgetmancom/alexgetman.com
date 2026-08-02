import { desc, eq, inArray, or } from "drizzle-orm";
import { PRESETS, presetName, TARGETS, targetLocale } from "../../botTargets.js";
import { effectivePostTargets, registeredPostTargetIds } from "../../channels/registry.js";
import { listStudioMediaAssets, mediaItemsFromAssets, requireStudioMediaAssets } from "../../content/assets.js";
import { createDraftFromMessage, requireDraft } from "../../content/drafts.js";
import type { DraftMessage } from "../../content/message.js";
import type { BackendDb } from "../../db/client.js";
import { draftEntityCandidates, draftSources, drafts, postEvents, studioNotificationSettings } from "../../db/schema.js";
import { recordDomainEvent } from "../../domain/events.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { cancelScheduledNotifications, scheduleReminder } from "../../notifications/jobs.js";
import { cancelDraft, cancelRemainingPostJobs } from "../../publishing/draft-lifecycle.js";
import { mediaPolicyForTarget } from "../../publishing/media-policy.js";
import { publicationPreflight } from "../../publishing/preflight.js";
import { publishDraftToQueue } from "../../publishing/publication-workflow.js";
import { parseManualSchedule, scheduleClockToday } from "../../publishing/schedule.js";
import { parseTargets } from "../../publishing/targets.js";
import { queueDraftStoryCards, type StoryPublishMode, setStoryPublishMode, storyCardsForDraft } from "../../story-cards/store.js";
import { accessibleStudioActorIds, canAccessStudioOwner, studioActorIds } from "../access.js";
import { postDeliveryProjections } from "../projections.js";
import { postProgressState } from "./post-progress.js";

type ScheduleInput = { ruAt: Date | null; enAt: Date | null };
type ScheduleScope = "ru" | "en" | "both";
type EditInput = {
  locale: "ru" | "en";
  text: string;
  entities: unknown[];
  media: Record<string, unknown>[];
  replaceMediaOnly?: boolean;
  /** Caller has already recognized an explicit "clear media" command in its own transport. */
  clearMedia?: boolean;
};
type DraftEntityCandidate = { kind: "company" | "model" | "person" | "topic"; slug: string; titleRu: string; titleEn: string | null };

/** Commands for post drafts. These are deliberately transport-free and become the
 * single entry point for Telegram, Web Studio and later MCP mutations. */
export function postService(backendDb: BackendDb, config: BackendConfig) {
  return {
    create(actorId: number, message: DraftMessage): number {
      return createDraftFromMessage(backendDb, actorId, message);
    },
    get(actorId: number, draftId: number) {
      return requireOwnedDraft(backendDb, config, actorId, draftId);
    },
    list(actorId: number, limit = 50) {
      return backendDb.db
        .select()
        .from(drafts)
        .where(inArray(drafts.actorId, accessibleStudioActorIds(config, actorId)))
        .orderBy(desc(drafts.updatedAt))
        .limit(limit)
        .all();
    },
    validate(actorId: number, draftId: number) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      return publicationPreflight({
        ...draft,
        targets_json: JSON.stringify(effectivePostTargets(backendDb, parseTargets(draft.targets_json))),
      });
    },
    preview(actorId: number, draftId: number) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const ruMedia = draftMedia(draft, "ru");
      const enMedia = draftMedia(draft, "en");
      const storyCards = storyCardsForDraft(backendDb, draftId);
      const storyCardsReady = ["ru", "en"].every((locale) =>
        storyCards.some((card) => card.locale === locale && card.status === "ready" && card.localPath),
      );
      const targets = effectivePostTargets(backendDb, parseTargets(draft.targets_json));
      return {
        id: draft.id,
        status: draft.status,
        locales: [
          {
            locale: "ru" as const,
            text: draft.text_ru,
            entities: parseJsonArray(draft.text_ru_entities_json),
            media: ruMedia,
          },
          { locale: "en" as const, text: draft.text_en_approved, entities: [], media: enMedia },
        ],
        targets,
        sources: backendDb.db.select().from(draftSources).where(eq(draftSources.draftId, draftId)).orderBy(draftSources.sortOrder).all(),
        mediaPolicy: Object.entries(targets)
          .filter(([, enabled]) => enabled)
          .map(([target]) => mediaPolicyForTarget(target, targetLocale(target) === "ru" ? ruMedia : enMedia)),
        delivery: postDeliveryProjections(draft, storyCardsReady),
        storyCards,
      };
    },
    setStoryPublishMode(actorId: number, draftId: number, mode: StoryPublishMode): void {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      setStoryPublishMode(backendDb, draftId, mode);
    },
    replaceSources(actorId: number, draftId: number, urls: string[]): void {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      const now = new Date().toISOString();
      backendDb.db.delete(draftSources).where(eq(draftSources.draftId, draftId)).run();
      const uniqueUrls = [...new Set(urls)];
      if (uniqueUrls.length === 0) return;
      backendDb.db
        .insert(draftSources)
        .values(
          uniqueUrls.map((url, sortOrder) => ({
            draftId,
            url,
            labelRu: sourceLabel(url),
            labelEn: sourceLabel(url),
            sortOrder,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run();
    },
    replaceEntityCandidates(actorId: number, draftId: number, candidates: DraftEntityCandidate[]): void {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      const now = new Date().toISOString();
      backendDb.db.delete(draftEntityCandidates).where(eq(draftEntityCandidates.draftId, draftId)).run();
      if (candidates.length)
        backendDb.db
          .insert(draftEntityCandidates)
          .values(candidates.map((entity) => ({ ...entity, draftId, status: "suggested", createdAt: now, updatedAt: now })))
          .run();
    },
    acceptEntityCandidates(actorId: number, draftId: number): void {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      backendDb.db
        .update(draftEntityCandidates)
        .set({ status: "accepted", updatedAt: new Date().toISOString() })
        .where(eq(draftEntityCandidates.draftId, draftId))
        .run();
    },
    /** Waives the 500-character Threads rule for this draft: the overflow becomes
     * a reply chain. Deliberately has no "off" command — editing the text resets
     * it, and a draft nobody waived is the normal state. */
    approveThreadsChain(actorId: number, draftId: number): void {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      backendDb.db.update(drafts).set({ threadsChainApproved: 1, updatedAt: new Date().toISOString() }).where(eq(drafts.id, draftId)).run();
      recordDomainEvent(backendDb, {
        ref: `draft:${draftId}`,
        type: "content.draft.threads-chain-approved",
        severity: "info",
        message: `Draft #${draftId} waived the Threads single-post rule`,
        details: {},
      });
    },
    publish(actorId: number, draftId: number): number {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      return publishDraftToQueue(backendDb, draftId);
    },
    schedule(actorId: number, draftId: number, input: ScheduleInput): number {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ...input });
      const scheduled = requireOwnedDraft(backendDb, config, actorId, draftId);
      const preference = workspaceNotificationPreference(backendDb, config);
      const title = draft.text_ru.trim().split("\n")[0]?.slice(0, 100) || `Post #${postId}`;
      if (scheduled.scheduled_at)
        scheduleReminder(backendDb, {
          actorId: actorId,
          ref: `post:${postId}`,
          kind: "post.ru",
          publishAt: new Date(scheduled.scheduled_at),
          title,
          targets: localeTargets(backendDb, draft.targets_json, "ru"),
          preference,
        });
      if (scheduled.scheduled_en_at)
        scheduleReminder(backendDb, {
          actorId: actorId,
          ref: `post:${postId}`,
          kind: "post.en",
          publishAt: new Date(scheduled.scheduled_en_at),
          title,
          targets: localeTargets(backendDb, draft.targets_json, "en"),
          preference,
        });
      return postId;
    },
    hasLocaleTargets(actorId: number, draftId: number, locale: "ru" | "en"): boolean {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      return hasLocaleTarget(effectivePostTargets(backendDb, parseTargets(draft.targets_json)), locale);
    },
    /** Resolves a slot-button clock (`HH:MM` MSK) to its next occurrence. */
    slotTime(clock: string): Date {
      return scheduleClockToday(clock);
    },
    manualSchedule(actorId: number, draftId: number, scope: ScheduleScope, value: string): ScheduleInput {
      return scheduleAt(requireOwnedDraft(backendDb, config, actorId, draftId), scope, parseManualSchedule(value));
    },
    scheduleAt(actorId: number, draftId: number, scope: ScheduleScope, value: Date): ScheduleInput {
      return scheduleAt(requireOwnedDraft(backendDb, config, actorId, draftId), scope, value);
    },
    cancel(actorId: number, draftId: number): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      cancelDraft(backendDb, draftId);
      if (draft.post_id != null) cancelScheduledNotifications(backendDb, `post:${draft.post_id}`);
    },
    cancelRemaining(actorId: number, draftId: number): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      cancelRemainingPostJobs(backendDb, draftId);
      if (draft.post_id != null) cancelScheduledNotifications(backendDb, `post:${draft.post_id}`);
    },
    progress(actorId: number, draftId: number) {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      return postProgressState(backendDb, draftId);
    },
    status(actorId: number, draftId: number) {
      return postProgressState(backendDb, requireOwnedDraft(backendDb, config, actorId, draftId).id);
    },
    history(actorId: number, draftId: number, limit = 50) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const scope =
        draft.post_id == null
          ? eq(postEvents.postKey, `draft:${draft.id}`)
          : or(eq(postEvents.postKey, `draft:${draft.id}`), eq(postEvents.postKey, `post:${draft.post_id}`));
      return backendDb.db
        .select()
        .from(postEvents)
        .where(scope)
        .orderBy(desc(postEvents.createdAt), desc(postEvents.id))
        .limit(limit)
        .all();
    },
    toggleTarget(actorId: number, draftId: number, target: string): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      if (!TARGETS.some(({ id }) => id === target)) throw new StudioError("err.unknown-target");
      const registered = registeredPostTargetIds(backendDb);
      if (registered.size && !registered.has(target)) throw new StudioError("err.unknown-target");
      const targets = parseTargets(draft.targets_json);
      targets[target] = !targets[target];
      saveTargets(backendDb, draftId, targets);
    },
    cycleMode(actorId: number, draftId: number): keyof typeof PRESETS {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const targets = parseTargets(draft.targets_json);
      const current = presetName(targets);
      const next = current === "full" ? "ru" : current === "ru" ? "en" : current === "en" ? "tg" : "full";
      const preset = effectivePostTargets(backendDb, PRESETS[next] ?? {});
      if (!preset) throw new StudioError("err.post-mode");
      saveTargets(backendDb, draftId, preset);
      return next;
    },
    edit(actorId: number, draftId: number, input: EditInput): void {
      editDraftContent(backendDb, config, actorId, draftId, input);
    },
    mediaAssets(actorId: number, limit = 50) {
      return listStudioMediaAssets(backendDb, actorId, limit, accessibleStudioActorIds(config, actorId));
    },
    attachMediaAssets(actorId: number, draftId: number, locale: "ru" | "en", assetIds: number[], replace = false): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const assets = mediaItemsFromAssets(
        requireStudioMediaAssets(backendDb, actorId, assetIds, accessibleStudioActorIds(config, actorId)),
      );
      const key = locale === "ru" ? "mediaRuJson" : "mediaEnJson";
      const current = replace ? [] : draftMedia(draft, locale);
      backendDb.db
        .update(drafts)
        .set({ [key]: JSON.stringify([...current, ...assets]), updatedAt: new Date().toISOString() })
        .where(eq(drafts.id, draftId))
        .run();
      queueDraftStoryCards(backendDb, draftId);
      recordDomainEvent(backendDb, {
        ref: `draft:${draftId}`,
        type: "content.draft.media_attached",
        severity: "info",
        message: `Draft #${draftId} media attached`,
        details: { locale, asset_ids: assetIds, replace },
      });
    },
    removeMedia(actorId: number, draftId: number, locale: "ru" | "en", assetIds: number[]): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const current = draftMedia(draft, locale);
      const removed = new Set(assetIds);
      const media = current.filter((item) => !removed.has(Number(item.asset_id)));
      backendDb.db
        .update(drafts)
        .set({ [locale === "ru" ? "mediaRuJson" : "mediaEnJson"]: JSON.stringify(media), updatedAt: new Date().toISOString() })
        .where(eq(drafts.id, draftId))
        .run();
      queueDraftStoryCards(backendDb, draftId);
      recordDomainEvent(backendDb, {
        ref: `draft:${draftId}`,
        type: "content.draft.media_removed",
        severity: "info",
        message: `Draft #${draftId} media removed`,
        details: { locale, asset_ids: assetIds },
      });
    },
  };
}

function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function workspaceNotificationPreference(backendDb: BackendDb, config: BackendConfig) {
  const actorIds = studioActorIds(config);
  const rows = actorIds.length
    ? backendDb.db.select().from(studioNotificationSettings).where(inArray(studioNotificationSettings.actorId, actorIds)).all()
    : [];
  const byActor = new Map(rows.map((row) => [row.actorId, row]));
  return {
    remindersEnabled: actorIds.some((actorId) => byActor.get(actorId)?.remindersEnabled !== 0),
    reminderMinutes: config.VIDEO_REMINDER_MINUTES,
    completionEnabled: true,
  };
}

function localeTargets(backendDb: BackendDb, json: string, locale: "ru" | "en"): string[] {
  return Object.entries(effectivePostTargets(backendDb, parseTargets(json)))
    .filter(([target, enabled]) => enabled && targetLocale(target) === locale)
    .map(([target]) => target);
}

function editDraftContent(backendDb: BackendDb, config: BackendConfig, actorId: number, draftId: number, input: EditInput): void {
  requireOwnedDraft(backendDb, config, actorId, draftId);
  const clearMedia = Boolean(input.clearMedia);
  const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  const ru = input.locale === "ru";
  if (clearMedia) update[ru ? "mediaRuJson" : "mediaEnJson"] = null;
  else {
    if (input.media.length) update[ru ? "mediaRuJson" : "mediaEnJson"] = JSON.stringify(input.media);
    if (!input.replaceMediaOnly && input.text) {
      update[ru ? "textRu" : "textEnApproved"] = input.text;
      update[ru ? "textRuEntitiesJson" : "textEnEntitiesJson"] = JSON.stringify(input.entities);
      // The waiver was given for a specific text the author had read. New text is
      // a new decision, so the 500-character rule applies again until waived anew.
      update.threadsChainApproved = 0;
    }
  }
  if (Object.keys(update).length === 1) throw new StudioError("err.post-no-edit");
  backendDb.db.update(drafts).set(update).where(eq(drafts.id, draftId)).run();
  queueDraftStoryCards(backendDb, draftId);
  recordDomainEvent(backendDb, {
    ref: `draft:${draftId}`,
    type: "content.draft.edited",
    severity: "info",
    message: `Draft #${draftId} content updated`,
    details: { locale: input.locale, media_changed: input.media.length > 0 || clearMedia, text_changed: !input.replaceMediaOnly },
  });
}

function hasLocaleTarget(targets: Record<string, boolean>, locale: "ru" | "en"): boolean {
  return Object.entries(targets).some(([target, enabled]) => enabled && targetLocale(target) === locale);
}

function scheduleAt(draft: ReturnType<typeof requireDraft>, scope: ScheduleScope, value: Date): ScheduleInput {
  return {
    ruAt: scope === "en" ? dateOrNull(draft.scheduled_at) : value,
    enAt: scope === "ru" ? dateOrNull(draft.scheduled_en_at) : value,
  };
}

function dateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function requireOwnedDraft(backendDb: BackendDb, config: BackendConfig, actorId: number, draftId: number) {
  const draft = requireDraft(backendDb, draftId);
  if (!canAccessStudioOwner(config, actorId, draft.actor_id)) throw new StudioError("err.post-not-yours");
  return draft;
}

/** A legacy or truncated JSON column must surface as an empty list, not as a
 * raw SyntaxError escaping a Studio verb: every transport (Telegram, MCP, Web)
 * only knows how to render StudioError and would show a generic failure. */
function parseJsonArray(value: string | null): Record<string, unknown>[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
  } catch {
    return [];
  }
}

function draftMedia(draft: ReturnType<typeof requireDraft>, locale: "ru" | "en"): Record<string, unknown>[] {
  return parseJsonArray(locale === "ru" ? draft.media_ru_json : draft.media_en_json);
}

function saveTargets(backendDb: BackendDb, draftId: number, targets: Record<string, boolean>): void {
  backendDb.db
    .update(drafts)
    .set({ targetsJson: JSON.stringify(targets), updatedAt: new Date().toISOString() })
    .where(eq(drafts.id, draftId))
    .run();
}
