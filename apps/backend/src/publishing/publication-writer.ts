import { and, eq, inArray } from "drizzle-orm";
import { isSiteTarget, targetLocale } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import {
  drafts,
  postLocales,
  posts,
  publicationPlans,
  publicationSources,
  publications,
  publishJobs,
  siteJobs,
  siteSourceItems,
} from "../db/schema.js";
import { localizeTargetPayload } from "./payload.js";
import type { PublicationPlan } from "./publication-plan.js";
import { enqueuePublishJobTx } from "./queue.js";

/** Persists one complete plan atomically, then materializes only its non-final jobs. */
export function persistPublicationPlan(backendDb: BackendDb, plan: PublicationPlan): void {
  backendDb.db.transaction((tx) => {
    const postValues = {
      postId: plan.postId,
      source: "studio",
      channel: "studio",
      messageId: plan.messageId,
      dateUtc: plan.ruAt ?? plan.enAt ?? plan.now,
      text: plan.textRu,
      textEn: plan.textEn,
      mediaJson: JSON.stringify(plan.mediaRu),
      mediaCount: plan.mediaRu.length,
      createdAt: plan.now,
      updatedAt: plan.now,
      rawJson: JSON.stringify(plan.payload),
    };
    tx.insert(posts)
      .values({ postKey: plan.postKey, ...postValues })
      .onConflictDoUpdate({
        target: posts.postKey,
        set: {
          postId: plan.postId,
          dateUtc: postValues.dateUtc,
          text: plan.textRu,
          textEn: plan.textEn,
          mediaJson: postValues.mediaJson,
          mediaCount: plan.mediaRu.length,
          updatedAt: plan.now,
          rawJson: postValues.rawJson,
        },
      })
      .run();
    for (const locale of plan.locales)
      tx.insert(postLocales)
        .values(locale)
        .onConflictDoUpdate({
          target: [postLocales.postId, postLocales.locale],
          set: {
            slug: locale.slug,
            text: locale.text,
            html: locale.html,
            entitiesJson: locale.entitiesJson,
            mediaJson: locale.mediaJson,
            siteEnabled: locale.siteEnabled,
            publishedAt: locale.publishedAt,
            updatedAt: plan.now,
          },
        })
        .run();
    const storedPlan = {
      draft_id: plan.draftId,
      targets: plan.targets,
      scheduled_at: plan.ruAt,
      scheduled_en_at: plan.enAt,
      created_at: plan.now,
    };
    tx.insert(publicationPlans)
      .values({ postId: plan.postId, planJson: storedPlan, createdAt: plan.now, updatedAt: plan.now })
      .onConflictDoUpdate({ target: publicationPlans.postId, set: { planJson: storedPlan, updatedAt: plan.now } })
      .run();
    tx.insert(publicationSources)
      .values({ postId: plan.postId, itemJson: plan.payload, createdAt: plan.now, updatedAt: plan.now })
      .onConflictDoUpdate({ target: publicationSources.postId, set: { itemJson: plan.payload, updatedAt: plan.now } })
      .run();
    tx.insert(siteSourceItems)
      .values({ messageId: plan.messageId, itemJson: plan.payload, createdAt: plan.now, updatedAt: plan.now })
      .onConflictDoUpdate({ target: siteSourceItems.messageId, set: { itemJson: plan.payload, updatedAt: plan.now } })
      .run();
    tx.delete(publishJobs)
      .where(and(eq(publishJobs.postId, plan.postId), inArray(publishJobs.status, ["queued", "failed"])))
      .run();
    tx.delete(siteJobs)
      .where(and(eq(siteJobs.postId, plan.postId), inArray(siteJobs.status, ["queued", "failed"])))
      .run();
    const finalTargets = new Set(
      tx
        .select({ target: publishJobs.target })
        .from(publishJobs)
        .where(and(eq(publishJobs.postId, plan.postId), inArray(publishJobs.status, ["publishing", "published", "skipped"])))
        .all()
        .map((row) => row.target),
    );
    for (const [target, enabled] of Object.entries(plan.targets)) {
      if (enabled && !isSiteTarget(target) && !finalTargets.has(target))
        enqueuePublishJobTx(tx, {
          postId: plan.postId,
          postKey: plan.postKey,
          messageId: plan.messageId,
          target,
          payload: localizeTargetPayload(plan.payload, target),
          publishAt: targetLocale(target) === "en" ? plan.enAt : plan.ruAt,
        });
    }
    for (const [locale, enabled, publishAt] of [
      ["ru", plan.targets.site_ru, plan.ruAt],
      ["en", plan.targets.site_en, plan.enAt],
    ] as const) {
      if (enabled && publishAt)
        tx.insert(siteJobs)
          .values({
            postId: plan.postId,
            messageId: plan.messageId,
            reason: `publish_${locale}`,
            status: "queued",
            nextAttemptAt: publishAt,
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
    tx.update(publications).set({ status: "scheduled", updatedAt: plan.now }).where(eq(publications.postId, plan.postId)).run();
  });
}
