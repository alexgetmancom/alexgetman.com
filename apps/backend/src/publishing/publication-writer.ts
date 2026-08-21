import { and, eq, inArray } from "drizzle-orm";
import { isSiteTarget, targetLocale } from "../botTargets.js";
import type { UnsafeBackendDb } from "../db/client.js";
import { drafts, postLocales, publishJobs, siteJobs } from "../db/schema.js";
import { localizeTargetPayload } from "./payload.js";
import type { PublicationPlan } from "./publication-plan.js";
import { enqueuePublishJobTx } from "./queue.js";

export function persistPublicationPlanTx(tx: UnsafeBackendDb["db"], plan: PublicationPlan): void {
  for (const locale of plan.locales) {
    const publishedAt = locale.source.siteEnabled ? (locale.source.publishAt ?? (plan.mode === "immediate" ? plan.now : null)) : null;
    tx.update(postLocales)
      .set({
        slug: locale.source.slug,
        html: locale.html,
        entitiesJson: typeof locale.entitiesJson === "string" ? locale.entitiesJson : null,
        storyMediaJson: locale.source.storyMedia,
        siteMediaJson: locale.source.siteMedia,
        siteEnabled: locale.source.siteEnabled ? 1 : 0,
        publishAt: locale.source.publishAt,
        publishedAt,
        updatedAt: plan.now,
      })
      .where(and(eq(postLocales.draftId, plan.draftId), eq(postLocales.locale, locale.locale)))
      .run();
  }
  tx.delete(publishJobs)
    .where(and(eq(publishJobs.publicationKey, plan.publicationKey), inArray(publishJobs.status, ["queued", "failed"])))
    .run();
  tx.delete(siteJobs)
    .where(and(eq(siteJobs.publicationKey, plan.publicationKey), inArray(siteJobs.status, ["queued", "failed"])))
    .run();
  // Targets whose delivery is settled or actively in flight are not replanned.
  // "publishing" counts as final on purpose: a worker already holds that job
  // and may have hit the platform, so rewriting its payload risks a duplicate
  // post. Re-planning a publication mid-delivery therefore leaves those
  // targets on the previous plan — visible to the user, and intended.
  const finalTargets = new Set(
    tx
      .select({ target: publishJobs.target })
      .from(publishJobs)
      .where(
        and(
          eq(publishJobs.publicationKey, plan.publicationKey),
          inArray(publishJobs.status, ["publishing", "published", "skipped", "verification_required"]),
        ),
      )
      .all()
      .map((row) => row.target),
  );
  const finalSiteLocales = new Set(
    tx
      .select({ reason: siteJobs.reason })
      .from(siteJobs)
      .where(and(eq(siteJobs.publicationKey, plan.publicationKey), inArray(siteJobs.status, ["rendering", "published"])))
      .all()
      .map((row) => row.reason.match(/(?:^|_)(ru|en)(?:_|$)/)?.[1])
      .filter((locale): locale is "ru" | "en" => locale === "ru" || locale === "en"),
  );
  for (const [target, enabled] of Object.entries(plan.targets)) {
    const publishAt = publishAtForTarget(plan, target);
    if (enabled && publishAt != null && !isSiteTarget(target) && !finalTargets.has(target))
      enqueuePublishJobTx(tx, {
        publicationKey: plan.publicationKey,
        target,
        payload: localizeTargetPayload(plan.payload, target),
        publishAt,
      });
  }
  for (const [locale, enabled] of [
    ["ru", plan.targets.site_ru],
    ["en", plan.targets.site_en],
  ] as const) {
    const publishAt = publishAtForLocale(plan, locale);
    if (enabled && publishAt != null && !finalSiteLocales.has(locale))
      tx.insert(siteJobs)
        .values({
          publicationKey: plan.publicationKey,
          messageId: plan.messageId,
          reason: `site_${locale}`,
          status: "queued",
          nextAttemptAt: publishAt ?? plan.now,
          createdAt: plan.now,
          updatedAt: plan.now,
        })
        .run();
  }
  tx.update(drafts)
    .set({
      status: "scheduled",
      postId: plan.postId,
      publishMode: plan.mode,
      scheduledAt: plan.ruAt,
      scheduledEnAt: plan.enAt,
      updatedAt: plan.now,
    })
    .where(eq(drafts.id, plan.draftId))
    .run();
}

function publishAtForTarget(plan: PublicationPlan, target: string): string | null {
  const locale = targetLocale(target);
  return locale ? publishAtForLocale(plan, locale) : null;
}

function publishAtForLocale(plan: PublicationPlan, locale: "ru" | "en"): string | null {
  if (plan.mode === "immediate") return plan.now;
  return locale === "en" ? plan.enAt : plan.ruAt;
}
