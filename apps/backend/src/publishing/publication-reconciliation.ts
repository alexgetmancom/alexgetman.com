import { and, eq } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { targetLocale } from "../botTargets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postEvents, publicationPlans, publications, publishJobs, siteJobs } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import { effectivePublicationStatus, planObject, planScheduleAt } from "./state.js";

type PublicationJob = { target: string; status: string; error: string | null };

/** Reconciles target jobs into one publication state. Queue mechanics do not own this read model. */
export function reconcilePublication(backendDb: BackendDb, postId: number): void {
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
  const site = unsafeDb(backendDb)
    .db.select({ target: siteJobs.reason, status: siteJobs.status, error: siteJobs.lastError })
    .from(siteJobs)
    .where(eq(siteJobs.postId, postId))
    .all();
  const all: PublicationJob[] = [...social, ...site];
  const plan = publicationPlan(backendDb, postId);
  emitLocaleCompletion(backendDb, postId, all, plan);
  const effectiveStatus = effectivePublicationStatus(
    all.map((job) => job.status),
    plan,
  );
  if (!effectiveStatus) return;
  const now = backendDb.clock.now().toISOString();
  unsafeDb(backendDb).db.transaction((tx) => {
    tx.update(publications).set({ status: effectiveStatus, updatedAt: now }).where(eq(publications.postId, postId)).run();
    tx.update(drafts).set({ status: effectiveStatus, updatedAt: now }).where(eq(drafts.postId, postId)).run();
  });
  if (effectiveStatus !== "scheduled" && previousStatus !== effectiveStatus && all.every((job) => FINAL_JOB_STATUSES.has(job.status))) {
    const failed = all.filter((job) => job.status === "failed" || job.status === "verification_required").length;
    recordDomainEvent(backendDb.events, {
      ref: publicationRef("post", postId),
      type: "delivery.post.completed",
      severity: "info",
      message: failed ? `Post #${postId} completed with ${failed} failed target(s)` : `Post #${postId} published successfully`,
      details: {
        post_id: postId,
        total: all.length,
        failed,
        published: all.filter((job) => job.status === "published" || job.status === "skipped").length,
      },
      cooldownSeconds: 60 * 60,
    });
  }
}

const FINAL_JOB_STATUSES = new Set(["published", "failed", "cancelled", "skipped", "verification_required"]);

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
    if (!completed.length || completed.some((job) => !FINAL_JOB_STATUSES.has(job.status))) continue;
    const remaining = [...enabledLocales]
      .filter((other) => other !== locale)
      .filter((other) => {
        const otherJobs = byLocale.get(other) ?? [];
        if (otherJobs.length && otherJobs.every((job) => FINAL_JOB_STATUSES.has(job.status))) return false;
        return isDeferredLocale(plan, locale, other);
      })
      .map((other) => ({ locale: other, scheduled_at: planScheduleAt(plan, other) }));
    if (!remaining.length) continue;

    const alreadyEmitted = unsafeDb(backendDb)
      .db.select({ id: postEvents.id })
      .from(postEvents)
      .where(
        and(
          eq(postEvents.postKey, publicationRef("post", postId)),
          eq(postEvents.eventType, "delivery.post.locale.completed"),
          eq(postEvents.target, locale),
        ),
      )
      .get();
    if (alreadyEmitted) continue;

    const failed = completed.filter((job) => job.status === "failed" || job.status === "verification_required").length;
    recordDomainEvent(backendDb.events, {
      ref: publicationRef("post", postId),
      type: "delivery.post.locale.completed",
      target: locale,
      severity: failed ? "warn" : "info",
      message: `Post #${postId} ${locale.toUpperCase()} publication part completed`,
      details: {
        post_id: postId,
        locale,
        total: completed.length,
        failed,
        published: completed.filter((job) => job.status === "published" || job.status === "skipped").length,
        targets: completed.map((job) => ({ target: job.target, status: job.status, error: job.error })),
        remaining,
      },
      cooldownSeconds: 365 * 24 * 60 * 60,
    });
  }
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
