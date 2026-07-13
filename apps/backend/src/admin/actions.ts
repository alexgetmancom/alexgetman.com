import { and, desc, eq, or } from "drizzle-orm";
import type { BackendConfig } from "../config.js";
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
import { localizeTargetPayload } from "../publishing/payload.js";

type PublicationRef = {
  input: string;
  postId: number | null;
  postKey: string;
  messageId: number;
};

export type CommandAction = {
  action: string;
  ref?: string;
  message_id?: number;
  target?: string;
  text_en?: string;
  media_en_json?: string;
  token?: string;
};

export async function runCommandAction(
  backendDb: BackendDb,
  input: CommandAction,
  config?: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const ref = input.ref || (input.message_id == null ? "" : String(input.message_id));
  if (!ref) throw new Error("missing publication ref");
  const publicationRef = resolvePublicationRef(backendDb, ref);
  if (!publicationRef) throw new Error(`publication not found: ${ref}`);
  let result: Record<string, unknown>;
  if (input.action === "retry" || input.action === "republish") result = requeue(backendDb, publicationRef, input.target);
  else if (input.action === "edit_en") {
    result = editEnglish(backendDb, publicationRef, input.text_en ?? "");
    if (config) result.external = await editPublishedTargets(backendDb, publicationRef, null, input.text_en ?? "", config, fetchImpl);
  } else if (input.action === "replace_en_media") result = replaceEnglishMedia(backendDb, publicationRef, parseMedia(input.media_en_json));
  else if (input.action === "use_ru_media_for_en") result = replaceEnglishMedia(backendDb, publicationRef, null);
  else throw new Error(`unknown action: ${input.action}`);
  recordAction(backendDb, input.action, publicationRef, input.target ?? null, result);
  return result;
}

function requeue(backendDb: BackendDb, ref: PublicationRef, target?: string): Record<string, unknown> {
  const source = sourcePayload(backendDb, ref);
  const whereRef = ref.postId != null ? eq(publishJobs.postId, ref.postId) : eq(publishJobs.postKey, ref.postKey);
  const rows = backendDb.db
    .select()
    .from(publishJobs)
    .where(target ? and(whereRef, eq(publishJobs.target, target)) : whereRef)
    .orderBy(desc(publishJobs.jobId))
    .all();
  const latest = new Map<string, typeof publishJobs.$inferSelect>();
  for (const row of rows) if (!latest.has(row.target)) latest.set(row.target, row);
  if (latest.size === 0 && target) {
    const fallback = backendDb.db.select().from(publishJobs).where(whereRef).orderBy(desc(publishJobs.updatedAt)).get();
    const payload = localizeTargetPayload(Object.keys(source).length > 0 ? source : jsonObject(fallback?.payloadJson), target);
    if (Object.keys(payload).length === 0) throw new Error("no publish jobs found");
    const now = new Date().toISOString();
    const inserted = backendDb.db
      .insert(publishJobs)
      .values({
        postId: ref.postId,
        postKey: ref.postKey,
        messageId: ref.messageId,
        target,
        status: "queued",
        attemptCount: 0,
        publishAt: now,
        nextAttemptAt: null,
        lockedBy: null,
        lockedAt: null,
        payloadJson: payload,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (inserted) latest.set(target, inserted);
  }
  if (latest.size === 0) throw new Error("no publish jobs found");
  const now = new Date().toISOString();
  const queued: string[] = [];
  backendDb.db.transaction((tx) => {
    for (const [targetId, row] of latest) {
      const existing = tx
        .select({ jobId: publishJobs.jobId })
        .from(publishJobs)
        .where(
          and(
            ref.postId != null ? eq(publishJobs.postId, ref.postId) : eq(publishJobs.postKey, ref.postKey),
            eq(publishJobs.target, targetId),
            eq(publishJobs.status, "queued"),
          ),
        )
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
          postKey: row.postKey ?? ref.postKey,
          target: targetId,
          status: "queued",
          error: null,
          skipped: 0,
          updatedAt: now,
          rawJson: JSON.stringify({ requeued: true }),
        })
        .onConflictDoUpdate({
          target: [postTargets.postKey, postTargets.target],
          set: {
            status: "queued",
            error: null,
            skipped: 0,
            updatedAt: now,
            rawJson: JSON.stringify({ requeued: true }),
          },
        })
        .run();
      queued.push(targetId);
    }
    if (ref.postId != null)
      tx.update(publications).set({ status: "scheduled", updatedAt: now }).where(eq(publications.postId, ref.postId)).run();
  });
  return {
    ok: true,
    post_id: ref.postId,
    post_key: ref.postKey,
    message_id: ref.messageId,
    target: target ?? null,
    targets: queued,
  };
}

function editEnglish(backendDb: BackendDb, ref: PublicationRef, text: string): Record<string, unknown> {
  const value = text.trim();
  if (!value) throw new Error("text_en is required");
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    if (ref.postId != null) {
      tx.update(drafts).set({ textEnApproved: value, updatedAt: now }).where(eq(drafts.postId, ref.postId)).run();
      tx.update(postLocales)
        .set({ text: value, updatedAt: now })
        .where(and(eq(postLocales.postId, ref.postId), eq(postLocales.locale, "en")))
        .run();
    }
    tx.update(posts).set({ textEn: value, updatedAt: now }).where(eq(posts.postKey, ref.postKey)).run();
    updateSource(tx, ref, { text_en: value, bodyMarkdown: value }, now);
    enqueueRepairSiteJob(tx, ref, "edit_en", now);
  });
  return {
    ok: true,
    post_id: ref.postId,
    post_key: ref.postKey,
    text_en: true,
  };
}

function replaceEnglishMedia(backendDb: BackendDb, ref: PublicationRef, media: Record<string, unknown>[] | null): Record<string, unknown> {
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    if (ref.postId != null) {
      tx.update(drafts)
        .set({
          mediaEnJson: media == null ? null : JSON.stringify(media),
          updatedAt: now,
        })
        .where(eq(drafts.postId, ref.postId))
        .run();
      const ru = tx
        .select({ mediaJson: postLocales.mediaJson })
        .from(postLocales)
        .where(and(eq(postLocales.postId, ref.postId), eq(postLocales.locale, "ru")))
        .get();
      const effective = media == null ? (ru?.mediaJson ?? []) : media;
      tx.update(postLocales)
        .set({ mediaJson: effective, updatedAt: now })
        .where(and(eq(postLocales.postId, ref.postId), eq(postLocales.locale, "en")))
        .run();
    }
    updateSource(tx, ref, { media_en: media }, now);
    enqueueRepairSiteJob(tx, ref, media == null ? "use_ru_media_for_en" : "replace_en_media", now);
  });
  return {
    ok: true,
    post_id: ref.postId,
    post_key: ref.postKey,
    media_en: media != null,
  };
}

function updateSource(db: BackendDb["db"], ref: PublicationRef, patch: Record<string, unknown>, now: string): void {
  const row =
    ref.postId == null
      ? null
      : db
          .select({ itemJson: publicationSources.itemJson })
          .from(publicationSources)
          .where(eq(publicationSources.postId, ref.postId))
          .get();
  const source = { ...jsonObject(row?.itemJson), ...patch };
  if (ref.postId != null)
    db.update(publicationSources).set({ itemJson: source, updatedAt: now }).where(eq(publicationSources.postId, ref.postId)).run();
  const siteSource = db
    .select({ itemJson: siteSourceItems.itemJson })
    .from(siteSourceItems)
    .where(eq(siteSourceItems.messageId, ref.messageId))
    .get();
  const sitePayload = { ...jsonObject(siteSource?.itemJson), ...source };
  db.insert(siteSourceItems)
    .values({
      messageId: ref.messageId,
      itemJson: sitePayload,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: siteSourceItems.messageId,
      set: { itemJson: sitePayload, updatedAt: now },
    })
    .run();
}

function enqueueRepairSiteJob(db: BackendDb["db"], ref: PublicationRef, reason: string, now: string): void {
  db.insert(siteJobs)
    .values({
      postId: ref.postId,
      messageId: ref.messageId,
      reason,
      status: "queued",
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function resolvePublicationRef(backendDb: BackendDb, ref: string): PublicationRef | null {
  const trimmed = ref.trim();
  const postKeyRef = trimmed.startsWith("post:") || trimmed.startsWith("telegram:") ? trimmed : null;
  const numeric = trimmed.match(/^post:(\d+)$/)?.[1] ?? (/^\d+$/.test(trimmed) ? trimmed : null);
  if (postKeyRef) {
    const post = backendDb.db.select().from(posts).where(eq(posts.postKey, postKeyRef)).get();
    if (post)
      return {
        input: ref,
        postId: post.postId,
        postKey: post.postKey,
        messageId: post.messageId,
      };
  }
  if (!numeric) return null;
  const id = Number(numeric);
  const publication = backendDb.db
    .select({
      postId: publications.postId,
      telegramMessageId: publications.telegramMessageId,
    })
    .from(publications)
    .where(or(eq(publications.postId, id), eq(publications.telegramMessageId, id)))
    .get();
  if (publication) {
    const post = backendDb.db
      .select()
      .from(posts)
      .where(eq(posts.postKey, `post:${publication.postId}`))
      .get();
    return {
      input: ref,
      postId: publication.postId,
      postKey: `post:${publication.postId}`,
      messageId: post?.messageId ?? publication.telegramMessageId ?? publication.postId,
    };
  }
  const post = backendDb.db
    .select()
    .from(posts)
    .where(or(eq(posts.messageId, id), eq(posts.postId, id), eq(posts.postKey, `post:${id}`)))
    .get();
  return post
    ? {
        input: ref,
        postId: post.postId,
        postKey: post.postKey,
        messageId: post.messageId,
      }
    : null;
}

function parseMedia(raw: string | undefined): Record<string, unknown>[] | null {
  if (!raw || ["none", "null", "ru", "fallback"].includes(raw.trim().toLowerCase())) return null;
  const parsed = JSON.parse(raw) as unknown;
  const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
  if (!items || items.some((item) => !item || typeof item !== "object" || !(item as Record<string, unknown>).file_id))
    throw new Error("each media item needs file_id");
  return items as Record<string, unknown>[];
}

function recordAction(
  backendDb: BackendDb,
  action: string,
  ref: PublicationRef,
  target: string | null,
  details: Record<string, unknown>,
): void {
  const now = new Date().toISOString();
  backendDb.db
    .insert(opsActions)
    .values({
      actorType: "command-center",
      action,
      messageId: ref.messageId,
      target,
      status: "ok",
      detailsJson: JSON.stringify(details),
      createdAt: now,
      completedAt: now,
    })
    .run();
}

function sourcePayload(backendDb: BackendDb, ref: PublicationRef): Record<string, unknown> {
  if (ref.postId != null) {
    const publicationSource = backendDb.db
      .select({ itemJson: publicationSources.itemJson })
      .from(publicationSources)
      .where(eq(publicationSources.postId, ref.postId))
      .get();
    const payload = jsonObject(publicationSource?.itemJson);
    if (Object.keys(payload).length > 0) return payload;
  }
  const siteSource = backendDb.db
    .select({ itemJson: siteSourceItems.itemJson })
    .from(siteSourceItems)
    .where(eq(siteSourceItems.messageId, ref.messageId))
    .get();
  const payload = jsonObject(siteSource?.itemJson);
  if (Object.keys(payload).length > 0) return payload;
  return jsonObject(backendDb.db.select({ rawJson: posts.rawJson }).from(posts).where(eq(posts.postKey, ref.postKey)).get()?.rawJson);
}

async function editPublishedTargets(
  backendDb: BackendDb,
  ref: PublicationRef,
  textRu: string | null,
  textEn: string | null,
  config: BackendConfig,
  fetchImpl: typeof fetch,
): Promise<Array<Record<string, unknown>>> {
  const post = backendDb.db
    .select({ chatId: posts.chatId, mediaCount: posts.mediaCount })
    .from(posts)
    .where(eq(posts.postKey, ref.postKey))
    .get();
  const rows = backendDb.db
    .select({
      target: postTargets.target,
      status: postTargets.status,
      externalId: postTargets.externalId,
    })
    .from(postTargets)
    .where(eq(postTargets.postKey, ref.postKey))
    .all();
  const results: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (row.status !== "published" || !row.externalId) continue;
    try {
      if (row.target === "telegram" && textRu) {
        const token = config.controllerBotToken;
        if (!token) {
          results.push({
            target: row.target,
            ok: false,
            skipped: true,
            error: "missing CONTROLLER_BOT_TOKEN",
          });
          continue;
        }
        const method = Number(post?.mediaCount ?? 0) > 0 ? "editMessageCaption" : "editMessageText";
        const field = Number(post?.mediaCount ?? 0) > 0 ? "caption" : "text";
        results.push(
          await postJson(fetchImpl, `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/bot${token}/${method}`, row.target, {
            chat_id: post?.chatId || config.CHANNEL_USERNAME,
            message_id: Number(row.externalId),
            [field]: textRu,
          }),
        );
      } else if (row.target === "facebook" && textEn) {
        if (!config.FACEBOOK_PAGE_ACCESS_TOKEN) {
          results.push({
            target: row.target,
            ok: false,
            skipped: true,
            error: "missing FACEBOOK_PAGE_ACCESS_TOKEN",
          });
          continue;
        }
        results.push(
          await postJson(fetchImpl, `https://graph.facebook.com/${config.FACEBOOK_GRAPH_API_VERSION}/${row.externalId}`, row.target, {
            message: textEn,
            description: textEn,
            access_token: config.FACEBOOK_PAGE_ACCESS_TOKEN,
          }),
        );
      } else if (row.target === "facebook_ru" && textRu) {
        if (!config.FACEBOOK_RU_PAGE_ACCESS_TOKEN) {
          results.push({
            target: row.target,
            ok: false,
            skipped: true,
            error: "missing FACEBOOK_RU_PAGE_ACCESS_TOKEN",
          });
          continue;
        }
        results.push(
          await postJson(fetchImpl, `https://graph.facebook.com/${config.FACEBOOK_GRAPH_API_VERSION}/${row.externalId}`, row.target, {
            message: textRu,
            description: textRu,
            access_token: config.FACEBOOK_RU_PAGE_ACCESS_TOKEN,
          }),
        );
      } else if (row.target === "linkedin" && textEn) {
        if (!config.LINKEDIN_ACCESS_TOKEN) {
          results.push({
            target: row.target,
            ok: false,
            skipped: true,
            error: "missing LINKEDIN_ACCESS_TOKEN",
          });
          continue;
        }
        results.push(
          await postJson(
            fetchImpl,
            `https://api.linkedin.com/rest/posts/${encodeURIComponent(row.externalId)}`,
            row.target,
            { patch: { $set: { commentary: textEn } } },
            {
              Authorization: `Bearer ${config.LINKEDIN_ACCESS_TOKEN}`,
              "Linkedin-Version": config.LINKEDIN_API_VERSION,
              "X-Restli-Method": "PARTIAL_UPDATE",
              "X-Restli-Protocol-Version": "2.0.0",
            },
          ),
        );
      }
    } catch (error) {
      results.push({
        target: row.target,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  target: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  return {
    target,
    ok: response.ok && (body == null || body.ok !== false),
    status: response.status,
    response: body,
  };
}
