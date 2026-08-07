import { and, desc, eq, inArray, or } from "drizzle-orm";
import type {
  DraftEntityCandidate,
  DraftSource,
  FailedPublicationTarget,
  PostEventRecord,
  PublicationRetryResult,
  StudioPostStore,
} from "../../application/ports.js";
import { publicationRef } from "../../application/publication-ref.js";
import { jsonObject } from "../../json.js";
import { requeuedPostTarget, requeuedPublishJobColumns } from "../../publishing/job-policy.js";
import { localizeTargetPayload } from "../../publishing/payload.js";
import { siteReasonForTarget, siteTargetForReason } from "../../publishing/targets.js";
import {
  draftEntityCandidates,
  draftSources,
  drafts,
  postEvents,
  posts,
  postTargets,
  publicationSources,
  publications,
  publishJobs,
  siteJobs,
  siteSourceItems,
  studioNotificationSettings,
} from "../schema.js";
import type { BackendDatabase } from "../types.js";

type BackendTransaction = Parameters<BackendDatabase["transaction"]>[0] extends (tx: infer T) => unknown ? T : never;
type RetryJobRow = { jobId: number; status: string };

/** SQLite adapter for Studio post-specific persistence operations. */
export function createStudioPostStore(db: BackendDatabase): StudioPostStore {
  return {
    sources(draftId: number): DraftSource[] {
      return db.select().from(draftSources).where(eq(draftSources.draftId, draftId)).orderBy(draftSources.sortOrder).all();
    },

    replaceSources(draftId: number, urls: string[], now: string): void {
      db.delete(draftSources).where(eq(draftSources.draftId, draftId)).run();
      if (urls.length === 0) return;
      db.insert(draftSources)
        .values(
          urls.map((url, sortOrder) => ({
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

    replaceEntityCandidates(draftId: number, candidates: DraftEntityCandidate[], now: string): void {
      db.delete(draftEntityCandidates).where(eq(draftEntityCandidates.draftId, draftId)).run();
      if (candidates.length === 0) return;
      db.insert(draftEntityCandidates)
        .values(candidates.map((entity) => ({ ...entity, draftId, status: "suggested", createdAt: now, updatedAt: now })))
        .run();
    },

    acceptEntityCandidates(draftId: number, now: string): void {
      db.update(draftEntityCandidates).set({ status: "accepted", updatedAt: now }).where(eq(draftEntityCandidates.draftId, draftId)).run();
    },

    notificationSettings(actorIds: number[]) {
      return actorIds.length
        ? db
            .select({ actorId: studioNotificationSettings.actorId, remindersEnabled: studioNotificationSettings.remindersEnabled })
            .from(studioNotificationSettings)
            .where(inArray(studioNotificationSettings.actorId, actorIds))
            .all()
        : [];
    },

    history(draftId: number, postId: number | null, limit: number): PostEventRecord[] {
      const scope =
        postId == null
          ? or(eq(postEvents.postKey, publicationRef("draft", draftId)), eq(postEvents.postKey, `draft:${draftId}`))
          : or(
              eq(postEvents.postKey, publicationRef("draft", draftId)),
              eq(postEvents.postKey, publicationRef("post", postId)),
              eq(postEvents.postKey, `draft:${draftId}`),
              eq(postEvents.postKey, `post:${postId}`),
            );
      return db.select().from(postEvents).where(scope).orderBy(desc(postEvents.createdAt), desc(postEvents.id)).limit(limit).all();
    },

    progress(draftId: number) {
      const draft = db
        .select({ id: drafts.id, actorId: drafts.actorId, postId: drafts.postId, targetsJson: drafts.targetsJson })
        .from(drafts)
        .where(eq(drafts.id, draftId))
        .get();
      if (!draft) return null;
      return {
        draft,
        publishJobs:
          draft.postId == null
            ? []
            : db
                .select({ target: publishJobs.target, status: publishJobs.status, lastError: publishJobs.lastError })
                .from(publishJobs)
                .where(eq(publishJobs.postId, draft.postId))
                .all(),
        siteJobs:
          draft.postId == null
            ? []
            : db
                .select({ reason: siteJobs.reason, status: siteJobs.status, lastError: siteJobs.lastError })
                .from(siteJobs)
                .where(eq(siteJobs.postId, draft.postId))
                .all(),
      };
    },

    failedPublicationTargets(postId: number): FailedPublicationTarget[] {
      const social = db
        .select({ target: publishJobs.target, status: publishJobs.status, error: publishJobs.lastError, jobId: publishJobs.jobId })
        .from(publishJobs)
        .where(eq(publishJobs.postId, postId))
        .orderBy(desc(publishJobs.jobId))
        .all();
      const latestSocial = new Map<string, (typeof social)[number]>();
      for (const row of social) if (!latestSocial.has(row.target)) latestSocial.set(row.target, row);

      const site = db
        .select({ reason: siteJobs.reason, status: siteJobs.status, error: siteJobs.lastError, jobId: siteJobs.jobId })
        .from(siteJobs)
        .where(eq(siteJobs.postId, postId))
        .orderBy(desc(siteJobs.jobId))
        .all();
      const latestSite = new Map<string, (typeof site)[number]>();
      for (const row of site) {
        const target = siteTargetForReason(row.reason);
        if (target && !latestSite.has(target)) latestSite.set(target, row);
      }

      return [...latestSocial.entries(), ...latestSite.entries()].flatMap(([target, row]) => {
        if (row.status !== "failed" && row.status !== "verification_required") return [];
        return [{ target, status: row.status, error: row.error }];
      });
    },

    retryPublicationTargets(postId: number, targets: string[]): PublicationRetryResult[] {
      const requested = [...new Set(targets)];
      const now = new Date().toISOString();
      const results: PublicationRetryResult[] = [];
      let source: Record<string, unknown> | null = null;
      let changed = false;

      db.transaction((tx) => {
        for (const target of requested) {
          const siteTargetName = siteReasonForTarget(target);
          let result: PublicationRetryResult;

          if (siteTargetName) {
            result = retryPublicationTarget({
              target,
              latest: () =>
                tx
                  .select()
                  .from(siteJobs)
                  .where(and(eq(siteJobs.postId, postId), eq(siteJobs.reason, siteTargetName)))
                  .orderBy(desc(siteJobs.jobId))
                  .get(),
              queued: () =>
                tx
                  .select({ jobId: siteJobs.jobId })
                  .from(siteJobs)
                  .where(and(eq(siteJobs.postId, postId), eq(siteJobs.reason, siteTargetName), eq(siteJobs.status, "queued")))
                  .get() != null,
              requeue: (row) => {
                tx.update(siteJobs)
                  .set({
                    status: "queued",
                    attemptCount: 0,
                    nextAttemptAt: null,
                    lockedBy: null,
                    lockedAt: null,
                    lastError: null,
                    updatedAt: now,
                  })
                  .where(and(eq(siteJobs.jobId, row.jobId), inArray(siteJobs.status, ["failed", "verification_required"])))
                  .run();
                mirrorRequeuedTarget(tx, postId, target, now);
              },
            });
          } else {
            result = retryPublicationTarget({
              target,
              latest: () =>
                tx
                  .select()
                  .from(publishJobs)
                  .where(and(eq(publishJobs.postId, postId), eq(publishJobs.target, target)))
                  .orderBy(desc(publishJobs.jobId))
                  .get(),
              queued: () =>
                tx
                  .select({ jobId: publishJobs.jobId })
                  .from(publishJobs)
                  .where(and(eq(publishJobs.postId, postId), eq(publishJobs.target, target), eq(publishJobs.status, "queued")))
                  .get() != null,
              requeue: (row) => {
                let publicationPayload = source;
                if (publicationPayload === null) {
                  publicationPayload = publicationSource(db, postId);
                  source = publicationPayload;
                }
                const payload = localizeTargetPayload(
                  Object.keys(publicationPayload).length > 0 ? publicationPayload : jsonObject(row.payloadJson),
                  target,
                );
                tx.update(publishJobs)
                  .set(requeuedPublishJobColumns(payload, now))
                  .where(and(eq(publishJobs.jobId, row.jobId), inArray(publishJobs.status, ["failed", "verification_required"])))
                  .run();
                mirrorRequeuedTarget(tx, postId, target, now);
              },
            });
          }

          results.push(result);
          if (result.outcome === "requeued") changed = true;
        }
        if (changed) tx.update(publications).set({ status: "scheduled", updatedAt: now }).where(eq(publications.postId, postId)).run();
      });
      return results;
    },
  };
}

function retryPublicationTarget<T extends RetryJobRow>(input: {
  target: string;
  latest: () => T | undefined;
  queued: () => boolean;
  requeue: (row: T) => void;
}): PublicationRetryResult {
  const row = input.latest();
  if (!row) return { target: input.target, outcome: "not_failed" };
  if (input.queued()) return { target: input.target, outcome: "already_queued" };
  if (row.status !== "failed" && row.status !== "verification_required") {
    return { target: input.target, outcome: "not_failed" };
  }
  input.requeue(row);
  return { target: input.target, outcome: "requeued" };
}

function publicationSource(db: BackendDatabase, postId: number): Record<string, unknown> {
  const source = jsonObject(
    db.select({ itemJson: publicationSources.itemJson }).from(publicationSources).where(eq(publicationSources.postId, postId)).get()
      ?.itemJson,
  );
  if (Object.keys(source).length > 0) return source;
  const post = db.select({ messageId: posts.messageId, rawJson: posts.rawJson }).from(posts).where(eq(posts.postId, postId)).get();
  const siteSource = post
    ? jsonObject(
        db.select({ itemJson: siteSourceItems.itemJson }).from(siteSourceItems).where(eq(siteSourceItems.messageId, post.messageId)).get()
          ?.itemJson,
      )
    : {};
  return Object.keys(siteSource).length > 0 ? siteSource : jsonObject(post?.rawJson);
}

function mirrorRequeuedTarget(db: BackendTransaction, postId: number, target: string, now: string): void {
  const mirrored = requeuedPostTarget(`post:${postId}`, target, now);
  db.insert(postTargets)
    .values(mirrored.values)
    .onConflictDoUpdate({ target: [postTargets.postKey, postTargets.target], set: mirrored.patch })
    .run();
}

function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
