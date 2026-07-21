import { desc, eq, or } from "drizzle-orm";
import { PRESETS, presetName, TARGETS, targetLocale } from "../../botTargets.js";
import { listStudioMediaAssets, mediaItemsFromAssets, requireStudioMediaAssets } from "../../content/assets.js";
import { createDraftFromMessage, requireDraft } from "../../content/drafts.js";
import type { DraftMessage } from "../../content/message.js";
import type { BackendDb } from "../../db/client.js";
import { draftSources, drafts, postEvents, studioNotificationSettings } from "../../db/schema.js";
import { recordDomainEvent } from "../../domain/events.js";
import { StudioError } from "../../foundation/errors.js";
import { cancelScheduledNotifications, scheduleReminder } from "../../notifications/jobs.js";
import { cancelDraft, cancelRemainingPostJobs } from "../../publishing/draft-lifecycle.js";
import { mediaPolicyForTarget } from "../../publishing/media-policy.js";
import { publicationPreflight } from "../../publishing/preflight.js";
import { publishDraftToQueue } from "../../publishing/publication-workflow.js";
import { nextPublishingSlot, parseManualSchedule, rebalanceScheduledDrafts, schedulePreset } from "../../publishing/schedule.js";
import { parseTargets } from "../../publishing/targets.js";
import { postDeliveryProjections } from "../projections.js";
import { postProgressState } from "./post-progress.js";

type ScheduleInput = { ruAt: Date | null; enAt: Date | null };
type ScheduleScope = "ru" | "en" | "both";
type EditInput = { locale: "ru" | "en"; text: string; entities: unknown[]; media: Record<string, unknown>[]; replaceMediaOnly?: boolean };

/** Commands for post drafts. These are deliberately transport-free and become the
 * single entry point for Telegram, Web Studio and later MCP mutations. */
export function postService(backendDb: BackendDb) {
  return {
    create(actorId: number, message: DraftMessage): number {
      return createDraftFromMessage(backendDb, actorId, message);
    },
    get(actorId: number, draftId: number) {
      return requireOwnedDraft(backendDb, actorId, draftId);
    },
    list(actorId: number, limit = 50) {
      return backendDb.db.select().from(drafts).where(eq(drafts.adminId, actorId)).orderBy(desc(drafts.updatedAt)).limit(limit).all();
    },
    validate(actorId: number, draftId: number) {
      return publicationPreflight(requireOwnedDraft(backendDb, actorId, draftId));
    },
    preview(actorId: number, draftId: number) {
      const draft = requireOwnedDraft(backendDb, actorId, draftId);
      const ruMedia = JSON.parse(draft.media_ru_json ?? "[]") as unknown[];
      const enMedia = JSON.parse(draft.media_en_json ?? "[]") as unknown[];
      const targets = parseTargets(draft.targets_json);
      return {
        id: draft.id,
        status: draft.status,
        locales: [
          {
            locale: "ru" as const,
            text: draft.text_ru,
            entities: JSON.parse(draft.text_ru_entities_json ?? "[]"),
            media: ruMedia,
          },
          { locale: "en" as const, text: draft.text_en_approved, entities: [], media: enMedia },
        ],
        targets,
        sources: backendDb.db.select().from(draftSources).where(eq(draftSources.draftId, draftId)).orderBy(draftSources.sortOrder).all(),
        mediaPolicy: Object.entries(targets)
          .filter(([, enabled]) => enabled)
          .map(([target]) => mediaPolicyForTarget(target, targetLocale(target) === "ru" ? ruMedia : enMedia)),
        delivery: postDeliveryProjections(draft),
      };
    },
    replaceSources(actorId: number, draftId: number, urls: string[]): void {
      requireOwnedDraft(backendDb, actorId, draftId);
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
    publish(actorId: number, draftId: number): number {
      requireOwnedDraft(backendDb, actorId, draftId);
      return publishDraftToQueue(backendDb, draftId);
    },
    schedule(actorId: number, draftId: number, input: ScheduleInput): number {
      const draft = requireOwnedDraft(backendDb, actorId, draftId);
      const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ...input });
      rebalanceScheduledDrafts(backendDb);
      const scheduled = requireOwnedDraft(backendDb, actorId, draftId);
      const preference = notificationPreference(backendDb, actorId);
      const title = draft.text_ru.trim().split("\n")[0]?.slice(0, 100) || `Post #${postId}`;
      if (scheduled.scheduled_at)
        scheduleReminder(backendDb, {
          adminId: actorId,
          ref: `post:${postId}`,
          kind: "post.ru",
          publishAt: new Date(scheduled.scheduled_at),
          title,
          targets: localeTargets(draft.targets_json, "ru"),
          preference,
        });
      if (scheduled.scheduled_en_at)
        scheduleReminder(backendDb, {
          adminId: actorId,
          ref: `post:${postId}`,
          kind: "post.en",
          publishAt: new Date(scheduled.scheduled_en_at),
          title,
          targets: localeTargets(draft.targets_json, "en"),
          preference,
        });
      return postId;
    },
    scheduleChoice(actorId: number, draftId: number, choice: string): ScheduleInput {
      const draft = requireOwnedDraft(backendDb, actorId, draftId);
      const targets = parseTargets(draft.targets_json);
      if (choice === "auto") {
        return {
          ruAt: hasLocaleTarget(targets, "ru") ? nextPublishingSlot(backendDb, "ru") : null,
          enAt: hasLocaleTarget(targets, "en") ? nextPublishingSlot(backendDb, "en") : null,
        };
      }
      const value = schedulePreset(choice);
      return { ruAt: value, enAt: value };
    },
    manualSchedule(actorId: number, draftId: number, scope: ScheduleScope, value: string): ScheduleInput {
      return scheduleAt(requireOwnedDraft(backendDb, actorId, draftId), scope, parseManualSchedule(value));
    },
    scheduleAt(actorId: number, draftId: number, scope: ScheduleScope, value: Date): ScheduleInput {
      return scheduleAt(requireOwnedDraft(backendDb, actorId, draftId), scope, value);
    },
    cancel(actorId: number, draftId: number): void {
      const draft = requireOwnedDraft(backendDb, actorId, draftId);
      cancelDraft(backendDb, draftId);
      if (draft.post_id != null) cancelScheduledNotifications(backendDb, `post:${draft.post_id}`);
    },
    cancelRemaining(actorId: number, draftId: number): void {
      const draft = requireOwnedDraft(backendDb, actorId, draftId);
      cancelRemainingPostJobs(backendDb, draftId);
      if (draft.post_id != null) cancelScheduledNotifications(backendDb, `post:${draft.post_id}`);
    },
    progress(actorId: number, draftId: number) {
      requireOwnedDraft(backendDb, actorId, draftId);
      return postProgressState(backendDb, draftId);
    },
    status(actorId: number, draftId: number) {
      return postProgressState(backendDb, requireOwnedDraft(backendDb, actorId, draftId).id);
    },
    history(actorId: number, draftId: number, limit = 50) {
      const draft = requireOwnedDraft(backendDb, actorId, draftId);
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
      const draft = requireOwnedDraft(backendDb, actorId, draftId);
      if (!TARGETS.some(([id]) => id === target)) throw new StudioError("err.unknown-target");
      const targets = parseTargets(draft.targets_json);
      targets[target] = !targets[target];
      saveTargets(backendDb, draftId, targets);
    },
    cycleMode(actorId: number, draftId: number): keyof typeof PRESETS {
      const draft = requireOwnedDraft(backendDb, actorId, draftId);
      const targets = parseTargets(draft.targets_json);
      const current = presetName(targets);
      const next = current === "full" ? "ru" : current === "ru" ? "en" : current === "en" ? "tg" : "full";
      const preset = PRESETS[next];
      if (!preset) throw new StudioError("err.post-mode");
      saveTargets(backendDb, draftId, preset);
      return next;
    },
    edit(actorId: number, draftId: number, input: EditInput): void {
      editDraftContent(backendDb, actorId, draftId, input);
    },
    mediaAssets(actorId: number, limit = 50) {
      return listStudioMediaAssets(backendDb, actorId, limit);
    },
    attachMediaAssets(actorId: number, draftId: number, locale: "ru" | "en", assetIds: number[], replace = false): void {
      const draft = requireOwnedDraft(backendDb, actorId, draftId);
      const assets = mediaItemsFromAssets(requireStudioMediaAssets(backendDb, actorId, assetIds));
      const key = locale === "ru" ? "mediaRuJson" : "mediaEnJson";
      const current = replace ? [] : JSON.parse(locale === "ru" ? (draft.media_ru_json ?? "[]") : (draft.media_en_json ?? "[]"));
      backendDb.db
        .update(drafts)
        .set({ [key]: JSON.stringify([...current, ...assets]), updatedAt: new Date().toISOString() })
        .where(eq(drafts.id, draftId))
        .run();
      recordDomainEvent(backendDb, {
        ref: `draft:${draftId}`,
        type: "content.draft.media_attached",
        severity: "info",
        message: `Draft #${draftId} media attached`,
        details: { locale, asset_ids: assetIds, replace },
      });
    },
    removeMedia(actorId: number, draftId: number, locale: "ru" | "en", assetIds: number[]): void {
      const draft = requireOwnedDraft(backendDb, actorId, draftId);
      const current = JSON.parse(locale === "ru" ? (draft.media_ru_json ?? "[]") : (draft.media_en_json ?? "[]")) as Record<
        string,
        unknown
      >[];
      const removed = new Set(assetIds);
      const media = current.filter((item) => !removed.has(Number(item.asset_id)));
      backendDb.db
        .update(drafts)
        .set({ [locale === "ru" ? "mediaRuJson" : "mediaEnJson"]: JSON.stringify(media), updatedAt: new Date().toISOString() })
        .where(eq(drafts.id, draftId))
        .run();
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

function notificationPreference(backendDb: BackendDb, actorId: number) {
  const row = backendDb.db.select().from(studioNotificationSettings).where(eq(studioNotificationSettings.adminId, actorId)).get();
  return {
    remindersEnabled: row?.remindersEnabled !== 0,
    reminderMinutes: row?.reminderMinutes ?? 5,
    completionEnabled: row?.completionEnabled !== 0,
  };
}

function localeTargets(json: string, locale: "ru" | "en"): string[] {
  return Object.entries(parseTargets(json))
    .filter(([target, enabled]) => enabled && targetLocale(target) === locale)
    .map(([target]) => target);
}

function editDraftContent(backendDb: BackendDb, actorId: number, draftId: number, input: EditInput): void {
  requireOwnedDraft(backendDb, actorId, draftId);
  const cleanText = input.text.trim().toLowerCase();
  const clearMedia = cleanText === "/delmedia" || cleanText === "очистить" || cleanText === "без медиа" || cleanText === "clear media";
  const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  const ru = input.locale === "ru";
  if (clearMedia) update[ru ? "mediaRuJson" : "mediaEnJson"] = null;
  else {
    if (input.media.length) update[ru ? "mediaRuJson" : "mediaEnJson"] = JSON.stringify(input.media);
    if (!input.replaceMediaOnly && input.text) {
      update[ru ? "textRu" : "textEnApproved"] = input.text;
      update[ru ? "textRuEntitiesJson" : "textEnEntitiesJson"] = JSON.stringify(input.entities);
    }
  }
  if (Object.keys(update).length === 1) throw new StudioError("err.post-no-edit");
  backendDb.db.update(drafts).set(update).where(eq(drafts.id, draftId)).run();
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

function requireOwnedDraft(backendDb: BackendDb, actorId: number, draftId: number) {
  const draft = requireDraft(backendDb, draftId);
  if (draft.admin_id !== actorId) throw new StudioError("err.post-not-yours");
  return draft;
}

function saveTargets(backendDb: BackendDb, draftId: number, targets: Record<string, boolean>): void {
  backendDb.db
    .update(drafts)
    .set({ targetsJson: JSON.stringify(targets), updatedAt: new Date().toISOString() })
    .where(eq(drafts.id, draftId))
    .run();
}
