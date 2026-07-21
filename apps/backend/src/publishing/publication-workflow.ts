import { and, asc, eq } from "drizzle-orm";
import { requireDraft } from "../content/drafts.js";
import { enrichPublishedPostEntities } from "../content/entity-enrichment.js";
import type { BackendDb } from "../db/client.js";
import { draftEntityCandidates, draftSources, knowledgeEntities, postEntityLinks, postSources, publications } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import { assertPublicationPreflight } from "./preflight.js";
import { createPublicationPlan, type PublishMode } from "./publication-plan.js";
import { persistPublicationPlan } from "./publication-writer.js";
import { reconcilePublication } from "./queue.js";

type PublishDraftOptions = { mode?: PublishMode; ruAt?: Date | null; enAt?: Date | null };

/** Coordinates validated content, durable plan persistence and initial queue reconciliation. */
export function publishDraftToQueue(backendDb: BackendDb, draftId: number, options: PublishDraftOptions = {}): number {
  const draft = requireDraft(backendDb, draftId);
  assertPublicationPreflight(draft);
  const now = new Date().toISOString();
  const mode = options.mode ?? "immediate";
  const ruAt = mode === "immediate" ? now : (options.ruAt?.toISOString() ?? null);
  const enAt = mode === "immediate" ? now : (options.enAt?.toISOString() ?? null);
  const postId = ensurePublication(backendDb, draftId, now);
  copyDraftSources(backendDb, draftId, postId, now);
  copyAcceptedEntities(backendDb, draftId, postId, now);
  const plan = createPublicationPlan(draft, draftId, postId, { mode, ruAt, enAt }, now);
  persistPublicationPlan(backendDb, plan);
  enrichPublishedPostEntities(backendDb, postId);
  reconcilePublication(backendDb, postId);
  recordDomainEvent(backendDb, {
    ref: `post:${postId}`,
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

function copyAcceptedEntities(backendDb: BackendDb, draftId: number, postId: number, now: string): void {
  const candidates = backendDb.db
    .select()
    .from(draftEntityCandidates)
    .where(and(eq(draftEntityCandidates.draftId, draftId), eq(draftEntityCandidates.status, "accepted")))
    .all();
  for (const candidate of candidates) {
    backendDb.db
      .insert(knowledgeEntities)
      .values({
        kind: candidate.kind,
        slug: candidate.slug,
        titleRu: candidate.titleRu,
        titleEn: candidate.titleEn,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    const entity = backendDb.db
      .select({ id: knowledgeEntities.id })
      .from(knowledgeEntities)
      .where(and(eq(knowledgeEntities.kind, candidate.kind), eq(knowledgeEntities.slug, candidate.slug)))
      .get();
    if (entity) backendDb.db.insert(postEntityLinks).values({ postId, entityId: entity.id, createdAt: now }).onConflictDoNothing().run();
  }
}

function copyDraftSources(backendDb: BackendDb, draftId: number, postId: number, now: string): void {
  const sources = backendDb.db
    .select()
    .from(draftSources)
    .where(eq(draftSources.draftId, draftId))
    .orderBy(asc(draftSources.sortOrder))
    .all();
  for (const source of sources) {
    backendDb.db
      .insert(postSources)
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
      .onConflictDoNothing()
      .run();
  }
}

function ensurePublication(backendDb: BackendDb, draftId: number, now: string): number {
  const existing = backendDb.db.select({ postId: publications.postId }).from(publications).where(eq(publications.draftId, draftId)).get();
  if (existing?.postId != null) return existing.postId;
  const inserted = backendDb.db
    .insert(publications)
    .values({ status: "scheduled", draftId, createdAt: now, updatedAt: now })
    .returning({ postId: publications.postId })
    .get();
  if (inserted?.postId == null) throw new Error("publication insert did not return an id");
  return inserted.postId;
}
