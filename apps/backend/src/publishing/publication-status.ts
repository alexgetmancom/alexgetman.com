import { and, eq, isNull } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { isSiteTarget, targetLocale } from "../botTargets.js";
import { registeredPostTargetIds } from "../channels/registry.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, publicationEvents, publicationPlans, publications, publishJobs, siteJobs } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import { effectivePublicationStatus, isPostJobFinal, planObject, planScheduleAt } from "./state.js";

type PublicationJob = { target: string; status: string; error: string | null };

/** Folds the publication's target jobs into its one status. Not to be confused
 * with delivery's reconciliation, which asks the platform whether an ambiguous
 * publication actually landed — this one asks no one anything and writes no
 * delivery state. Both were called `publication-reconciliation`, and the file
 * that imports this one is the other. */
export function refreshPublicationStatus(backendDb: BackendDb, postId: number): void {
  const existing = unsafeDb(backendDb)
    .db.select({ status: publications.status })
    .from(publications)
    .where(eq(publications.postId, postId))
    .get();
  if (existing?.status === "cancelled") return;
  const previousStatus = existing?.status ?? null;
  const social = unsafeDb(backendDb)
    .db.select({ target: publishJobs.target, status: publishJobs.status, error: publishJobs.lastError })
    .from(publishJobs)
    .where(eq(publishJobs.postId, postId))
    .all();
  // Only the canonical site rows. A site job's reason is either a delivery
  // target (`site_ru`, `site_en`) or a repair (`edit_en`, `refresh_en_site`),
  // and counting repairs as targets meant one failed repair held the whole
  // publication in `failed` even after the real site page had published.
  const site = unsafeDb(backendDb)
    .db.select({ target: siteJobs.reason, status: siteJobs.status, error: siteJobs.lastError })
    .from(siteJobs)
    .where(eq(siteJobs.postId, postId))
    .all()
    .filter((job) => isSiteTarget(job.target));
  const all: PublicationJob[] = [...social, ...site];
  const plan = publicationPlan(backendDb, postId);
  emitLocaleCompletion(backendDb, postId, all, plan);
  const effectiveStatus = effectivePublicationStatus(
    all.map((job) => job.status),
    plan,
    registeredPostTargetIds(backendDb),
  );
  if (!effectiveStatus) return;
  const now = backendDb.clock.now().toISOString();
  // The completion event is announced once per transition, so the transition
  // itself has to be claimed atomically: the write carries the status this cycle
  // read, and a concurrent refresh that already moved it wins and returns
  // nothing. Announcing off the earlier read instead would send the card twice.
  const moved = unsafeDb(backendDb).db.transaction((tx) => {
    const claimed = tx
      .update(publications)
      .set({ status: effectiveStatus, updatedAt: now })
      .where(
        and(
          eq(publications.postId, postId),
          previousStatus == null ? isNull(publications.status) : eq(publications.status, previousStatus),
        ),
      )
      .returning({ postId: publications.postId })
      .get();
    if (!claimed) return false;
    tx.update(drafts).set({ status: effectiveStatus, updatedAt: now }).where(eq(drafts.postId, postId)).run();
    return true;
  });
  if (moved && effectiveStatus !== "scheduled" && previousStatus !== effectiveStatus && all.every((job) => isPostJobFinal(job.status))) {
    const counts = postJobCounts(all);
    recordDomainEvent(backendDb.events, {
      ref: publicationRef("post", postId),
      type: "delivery.post.completed",
      severity: "info",
      message: counts.failed
        ? `Post #${postId} completed with ${counts.failed} failed target(s)`
        : `Post #${postId} published successfully`,
      details: {
        post_id: postId,
        total: all.length,
        ...counts,
      },
    });
  }
}

function emitLocaleCompletion(backendDb: BackendDb, postId: number, jobs: PublicationJob[], plan: Record<string, unknown> | null): void {
  if (plan?.mode !== "scheduled") return;
  const targets = planObject(plan.targets);
  const enabledLocales = new Set<"ru" | "en">();
  for (const [target, enabled] of Object.entries(targets)) {
    if (enabled && targetLocale(target)) enabledLocales.add(targetLocale(target) as "ru" | "en");
  }
  if (enabledLocales.size < 2) return;

  const byLocale = new Map<"ru" | "en", PublicationJob[]>();
  for (const job of jobs) {
    const locale = targetLocale(job.target);
    if (!locale) continue;
    const group = byLocale.get(locale) ?? [];
    group.push(job);
    byLocale.set(locale, group);
  }

  for (const locale of ["ru", "en"] as const) {
    const completed = byLocale.get(locale) ?? [];
    if (!completed.length || completed.some((job) => !isPostJobFinal(job.status))) continue;
    const remaining = [...enabledLocales]
      .filter((other) => other !== locale)
      .filter((other) => {
        const otherJobs = byLocale.get(other) ?? [];
        if (otherJobs.length && otherJobs.every((job) => isPostJobFinal(job.status))) return false;
        return isDeferredLocale(plan, locale, other);
      })
      .map((other) => ({ locale: other, scheduled_at: planScheduleAt(plan, other) }));
    if (!remaining.length) continue;

    const alreadyEmitted = unsafeDb(backendDb)
      .db.select({ id: publicationEvents.id })
      .from(publicationEvents)
      .where(
        and(
          eq(publicationEvents.publicationKey, publicationRef("post", postId)),
          eq(publicationEvents.eventType, "delivery.post.locale.completed"),
          eq(publicationEvents.target, locale),
        ),
      )
      .get();
    if (alreadyEmitted) continue;

    const counts = postJobCounts(completed);
    recordDomainEvent(backendDb.events, {
      ref: publicationRef("post", postId),
      type: "delivery.post.locale.completed",
      target: locale,
      severity: counts.failed ? "warn" : "info",
      message: `Post #${postId} ${locale.toUpperCase()} publication part completed`,
      details: {
        post_id: postId,
        locale,
        total: completed.length,
        ...counts,
        targets: completed.map((job) => ({ target: job.target, status: job.status, error: job.error })),
        remaining,
      },
      cooldownSeconds: 365 * 24 * 60 * 60,
    });
  }
}

function postJobCounts(jobs: PublicationJob[]): { failed: number; published: number } {
  return {
    failed: jobs.filter((job) => job.status === "failed" || job.status === "verification_required").length,
    published: jobs.filter((job) => job.status === "published" || job.status === "skipped").length,
  };
}

function isDeferredLocale(plan: Record<string, unknown>, completed: "ru" | "en", remaining: "ru" | "en"): boolean {
  const completedAt = planScheduleAt(plan, completed);
  const remainingAt = planScheduleAt(plan, remaining);
  if (!remainingAt || !completedAt) return true;
  const completedTime = Date.parse(completedAt);
  const remainingTime = Date.parse(remainingAt);
  return Number.isFinite(remainingTime) && Number.isFinite(completedTime) && remainingTime > completedTime;
}

function publicationPlan(backendDb: BackendDb, postId: number): Record<string, unknown> | null {
  const value = unsafeDb(backendDb)
    .db.select({ planJson: publicationPlans.planJson })
    .from(publicationPlans)
    .where(eq(publicationPlans.postId, postId))
    .get()?.planJson;
  return planObject(value);
}
