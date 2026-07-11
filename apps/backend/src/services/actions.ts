import { and, desc, eq, or } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import {
  drafts,
  opsActions,
  postLocales,
  posts,
  postTargets,
  publicationSources,
  publications,
  publishJobs,
  siteJobs,
  siteSourceItems,
} from "../db/schema.js";
import { jsonObject } from "../json.js";
import { localizeTargetPayload } from "../publicationPayload.js";

export type CommandAction = {
  action: string;
  ref?: string;
  message_id?: number;
  target?: string;
  text_en?: string;
  media_en_json?: string;
  token?: string;
};

export function runCommandAction(backendDb: BackendDb, input: CommandAction): Record<string, unknown> {
  const ref = input.ref || (input.message_id == null ? "" : String(input.message_id));
  if (!ref) throw new Error("missing publication ref");
  const postId = resolvePostId(backendDb, ref);
  if (!postId) throw new Error(`publication not found: ${ref}`);
  let result: Record<string, unknown>;
  if (input.action === "retry" || input.action === "republish") result = requeue(backendDb, postId, input.target);
  else if (input.action === "edit_en") result = editEnglish(backendDb, postId, input.text_en ?? "");
  else if (input.action === "replace_en_media") result = replaceEnglishMedia(backendDb, postId, parseMedia(input.media_en_json));
  else if (input.action === "use_ru_media_for_en") result = replaceEnglishMedia(backendDb, postId, null);
  else throw new Error(`unknown action: ${input.action}`);
  recordAction(backendDb, input.action, postId, input.target ?? null, result);
  return result;
}

function requeue(backendDb: BackendDb, postId: number, target?: string): Record<string, unknown> {
  const source = jsonObject(
    backendDb.db
      .select({ itemJson: publicationSources.itemJson })
      .from(publicationSources)
      .where(eq(publicationSources.postId, postId))
      .get()?.itemJson,
  );
  const rows = backendDb.db
    .select()
    .from(publishJobs)
    .where(target ? and(eq(publishJobs.postId, postId), eq(publishJobs.target, target)) : eq(publishJobs.postId, postId))
    .orderBy(desc(publishJobs.jobId))
    .all();
  const latest = new Map<string, typeof publishJobs.$inferSelect>();
  for (const row of rows) if (!latest.has(row.target)) latest.set(row.target, row);
  if (latest.size === 0) throw new Error("no publish jobs found");
  const now = new Date().toISOString();
  const queued: string[] = [];
  backendDb.db.transaction((tx) => {
    for (const [targetId, row] of latest) {
      const existing = tx
        .select({ jobId: publishJobs.jobId })
        .from(publishJobs)
        .where(and(eq(publishJobs.postId, postId), eq(publishJobs.target, targetId), eq(publishJobs.status, "queued")))
        .get();
      if (!existing) {
        const payload = localizeTargetPayload(Object.keys(source).length > 0 ? source : jsonObject(row.payloadJson), targetId);
        tx.update(publishJobs)
          .set({
            status: "queued",
            attemptCount: 0,
            publishAt: now,
            nextAttemptAt: null,
            lockedBy: null,
            lockedAt: null,
            payloadJson: payload,
            lastError: null,
            updatedAt: now,
          })
          .where(eq(publishJobs.jobId, row.jobId))
          .run();
      }
      tx.insert(postTargets)
        .values({
          postKey: row.postKey ?? `post:${postId}`,
          target: targetId,
          status: "queued",
          error: null,
          skipped: 0,
          updatedAt: now,
          rawJson: JSON.stringify({ requeued: true }),
        })
        .onConflictDoUpdate({
          target: [postTargets.postKey, postTargets.target],
          set: { status: "queued", error: null, skipped: 0, updatedAt: now, rawJson: JSON.stringify({ requeued: true }) },
        })
        .run();
      queued.push(targetId);
    }
    tx.update(publications).set({ status: "published", updatedAt: now }).where(eq(publications.postId, postId)).run();
  });
  return { ok: true, post_id: postId, target: target ?? null, targets: queued };
}

function editEnglish(backendDb: BackendDb, postId: number, text: string): Record<string, unknown> {
  const value = text.trim();
  if (!value) throw new Error("text_en is required");
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    tx.update(drafts).set({ textEnApproved: value, updatedAt: now }).where(eq(drafts.postId, postId)).run();
    tx.update(postLocales)
      .set({ text: value, updatedAt: now })
      .where(and(eq(postLocales.postId, postId), eq(postLocales.locale, "en")))
      .run();
    tx.update(posts)
      .set({ textEn: value, updatedAt: now })
      .where(eq(posts.postKey, `post:${postId}`))
      .run();
    updateSource(tx, postId, { text_en: value, bodyMarkdown: value }, now);
    enqueueRepairSiteJob(tx, postId, "edit_en", now);
  });
  return { ok: true, post_id: postId, text_en: true };
}

function replaceEnglishMedia(backendDb: BackendDb, postId: number, media: Record<string, unknown>[] | null): Record<string, unknown> {
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    tx.update(drafts)
      .set({ mediaEnJson: media == null ? null : JSON.stringify(media), updatedAt: now })
      .where(eq(drafts.postId, postId))
      .run();
    const ru = tx
      .select({ mediaJson: postLocales.mediaJson })
      .from(postLocales)
      .where(and(eq(postLocales.postId, postId), eq(postLocales.locale, "ru")))
      .get();
    const effective = media == null ? (ru?.mediaJson ?? []) : media;
    tx.update(postLocales)
      .set({ mediaJson: effective, updatedAt: now })
      .where(and(eq(postLocales.postId, postId), eq(postLocales.locale, "en")))
      .run();
    updateSource(tx, postId, { media_en: media }, now);
    enqueueRepairSiteJob(tx, postId, media == null ? "use_ru_media_for_en" : "replace_en_media", now);
  });
  return { ok: true, post_id: postId, media_en: media != null };
}

function updateSource(db: BackendDb["db"], postId: number, patch: Record<string, unknown>, now: string): void {
  const row = db
    .select({ itemJson: publicationSources.itemJson })
    .from(publicationSources)
    .where(eq(publicationSources.postId, postId))
    .get();
  const source = { ...jsonObject(row?.itemJson), ...patch };
  db.update(publicationSources).set({ itemJson: source, updatedAt: now }).where(eq(publicationSources.postId, postId)).run();
  const message = db
    .select({ telegramMessageId: publications.telegramMessageId })
    .from(publications)
    .where(eq(publications.postId, postId))
    .get();
  if (message?.telegramMessageId)
    db.update(siteSourceItems)
      .set({ itemJson: source, updatedAt: now })
      .where(eq(siteSourceItems.messageId, message.telegramMessageId))
      .run();
}

function enqueueRepairSiteJob(db: BackendDb["db"], postId: number, reason: string, now: string): void {
  const publication = db
    .select({ telegramMessageId: publications.telegramMessageId, postId: publications.postId })
    .from(publications)
    .where(eq(publications.postId, postId))
    .get();
  if (!publication) throw new Error(`publication not found: ${postId}`);
  db.insert(siteJobs)
    .values({
      postId,
      messageId: publication.telegramMessageId ?? publication.postId,
      reason,
      status: "queued",
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function resolvePostId(backendDb: BackendDb, ref: string): number | null {
  const direct = ref.match(/^post:(\d+)$/)?.[1] ?? (/^\d+$/.test(ref) ? ref : null);
  if (!direct) return null;
  const id = Number(direct);
  const publication = backendDb.db
    .select({ postId: publications.postId })
    .from(publications)
    .where(or(eq(publications.postId, id), eq(publications.telegramMessageId, id)))
    .get();
  if (publication) return publication.postId;
  return (
    backendDb.db
      .select({ postId: posts.postId })
      .from(posts)
      .where(or(eq(posts.messageId, id), eq(posts.postKey, `post:${id}`)))
      .get()?.postId ?? null
  );
}

function parseMedia(raw: string | undefined): Record<string, unknown>[] | null {
  if (!raw || ["none", "null", "ru", "fallback"].includes(raw.trim().toLowerCase())) return null;
  const parsed = JSON.parse(raw) as unknown;
  const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
  if (!items || items.some((item) => !item || typeof item !== "object" || !(item as Record<string, unknown>).file_id))
    throw new Error("each media item needs file_id");
  return items as Record<string, unknown>[];
}

function recordAction(backendDb: BackendDb, action: string, postId: number, target: string | null, details: Record<string, unknown>): void {
  const message = backendDb.db
    .select({ telegramMessageId: publications.telegramMessageId })
    .from(publications)
    .where(eq(publications.postId, postId))
    .get();
  const now = new Date().toISOString();
  backendDb.db
    .insert(opsActions)
    .values({
      actorType: "command-center",
      action,
      messageId: message?.telegramMessageId ?? null,
      target,
      status: "ok",
      detailsJson: JSON.stringify(details),
      createdAt: now,
      completedAt: now,
    })
    .run();
}
