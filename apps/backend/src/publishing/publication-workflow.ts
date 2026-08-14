import { and, asc, eq, inArray } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { isStoryTarget } from "../botTargets.js";
import { effectivePostTargets, registeredPostTargetIds } from "../channels/registry.js";
import { requireDraft } from "../content/drafts.js";
import { enrichPublishedPostEntities } from "../content/entity-enrichment.js";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../db/client.js";
import { draftEntityCandidates, draftSources, knowledgeEntities, postEntityLinks, postSources, publications } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import { trackUsageSync } from "../observability/usage.js";
import { readyStoryCardMedia } from "../story-cards/store.js";
import { assertPublicationPreflight } from "./preflight.js";
import { createPublicationPlan, type PublishMode } from "./publication-plan.js";
import { reconcilePublication } from "./publication-reconciliation.js";
import { persistPublicationPlanTx } from "./publication-writer.js";
import { parseTargets } from "./targets.js";

type PublishDraftOptions = { mode?: PublishMode; ruAt?: Date | null; enAt?: Date | null; immediateLocale?: "ru" | "en" };

/** Coordinates validated content, durable plan persistence and initial queue reconciliation. */
export function publishDraftToQueue(backendDb: BackendDb, draftId: number, options: PublishDraftOptions = {}): number {
  return trackUsageSync(backendDb, "publishing.plan.create", () => publishDraftToQueueInternal(backendDb, draftId, options));
}

function publishDraftToQueueInternal(backendDb: BackendDb, draftId: number, options: PublishDraftOptions = {}): number {
  const draft = requireDraft(backendDb, draftId);
  const effectiveDraft = {
    ...draft,
    targets_json: JSON.stringify(effectivePostTargets(backendDb, parseTargets(draft.targets_json))),
  };
  assertPublicationPreflight(effectiveDraft);
  const now = new Date().toISOString();
  const mode = options.mode ?? "immediate";
  const ruAt = mode === "immediate" || options.immediateLocale === "ru" ? now : (options.ruAt?.toISOString() ?? null);
  const enAt = mode === "immediate" || options.immediateLocale === "en" ? now : (options.enAt?.toISOString() ?? null);
  // One transaction for the whole hand-off: a failure midway used to leave a
  // publications row with no plan behind it, which no worker picks up and no
  // retry path repairs. Every step below is synchronous, so this is free.
  const { postId, plan } = unsafeDb(backendDb).db.transaction((tx) => {
    const publicationId = ensurePublication(tx, draftId, now);
    copyDraftSources(tx, draftId, publicationId, now);
    copyAcceptedEntities(tx, draftId, publicationId, now);
    const registeredTargets = registeredPostTargetIds(backendDb);
    const storyCards = readyStoryCardMedia(unsafeDb(backendDb).db, draftId);
    const hasStoryTarget = Object.entries(parseTargets(effectiveDraft.targets_json)).some(
      ([target, enabled]) => enabled && isStoryTarget(target),
    );
    if (storyCards && hasStoryTarget && draft.story_publish_mode !== "all" && draft.story_publish_mode !== "site_only")
      throw new Error("Story delivery decision is required for a text-only post");
    const publicationPlan = createPublicationPlan(
      effectiveDraft,
      draftId,
      publicationId,
      { mode, ruAt, enAt },
      now,
      registeredTargets.size ? registeredTargets : undefined,
      storyCards ?? undefined,
    );
    persistPublicationPlanTx(tx, publicationPlan);
    enrichPublishedPostEntities(backendDb, publicationId);
    return { postId: publicationId, plan: publicationPlan };
  });
  reconcilePublication(backendDb, postId);
  recordDomainEvent(backendDb.events, {
    ref: publicationRef("post", postId),
    type: "publishing.plan.created",
    severity: "info",
    message: `Publication plan created for draft #${draftId}`,
    details: {
      draft_id: draftId,
      mode,
      ru_at: ruAt,
      en_at: enAt,
      targets: Object.keys(plan.targets).filter((target) => plan.targets[target]),
    },
  });
  return postId;
}

function copyAcceptedEntities(db: UnsafeBackendDb["db"], draftId: number, postId: number, now: string): void {
  const candidates = db
    .select()
    .from(draftEntityCandidates)
    .where(and(eq(draftEntityCandidates.draftId, draftId), eq(draftEntityCandidates.status, "accepted")))
    .all();
  if (!candidates.length) return;
  db.insert(knowledgeEntities)
    .values(
      candidates.map((candidate) => ({
        kind: candidate.kind,
        slug: candidate.slug,
        titleRu: candidate.titleRu,
        titleEn: candidate.titleEn,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing()
    .run();
  const kinds = [...new Set(candidates.map((candidate) => candidate.kind))];
  const candidateKeys = new Set(candidates.map((candidate) => `${candidate.kind}\u0000${candidate.slug}`));
  const entities = db
    .select({ id: knowledgeEntities.id, kind: knowledgeEntities.kind, slug: knowledgeEntities.slug })
    .from(knowledgeEntities)
    .where(inArray(knowledgeEntities.kind, kinds))
    .all()
    .filter((entity) => candidateKeys.has(`${entity.kind}\u0000${entity.slug}`));
  if (entities.length)
    db.insert(postEntityLinks)
      .values(entities.map((entity) => ({ postId, entityId: entity.id, createdAt: now })))
      .onConflictDoNothing()
      .run();
}

function copyDraftSources(db: UnsafeBackendDb["db"], draftId: number, postId: number, now: string): void {
  const sources = db.select().from(draftSources).where(eq(draftSources.draftId, draftId)).orderBy(asc(draftSources.sortOrder)).all();
  db.delete(postSources).where(eq(postSources.postId, postId)).run();
  for (const source of sources) {
    db.insert(postSources)
      .values({
        postId,
        url: source.url,
        labelRu: source.labelRu,
        labelEn: source.labelEn,
        displayKind: source.displayKind,
        sortOrder: source.sortOrder,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

function ensurePublication(db: UnsafeBackendDb["db"], draftId: number, now: string): number {
  const existing = db.select({ postId: publications.postId }).from(publications).where(eq(publications.draftId, draftId)).get();
  if (existing?.postId != null) return existing.postId;
  const inserted = db
    .insert(publications)
    .values({ status: "scheduled", draftId, createdAt: now, updatedAt: now })
    .returning({ postId: publications.postId })
    .get();
  if (inserted?.postId == null) throw new Error("publication insert did not return an id");
  return inserted.postId;
}
