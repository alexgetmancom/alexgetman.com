import { eq, or } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { posts, publicationSources, publications, siteSourceItems } from "../db/schema.js";
import { jsonObject } from "../json.js";

export type PublicationRef = { input: string; postId: number | null; postKey: string; messageId: number };

/** Resolves external command input to the stable publication identity used by Operations commands. */
export function resolvePublicationRef(backendDb: BackendDb, ref: string): PublicationRef | null {
  const trimmed = ref.trim();
  const postKeyRef = trimmed.startsWith("post:") || trimmed.startsWith("telegram:") ? trimmed : null;
  const numeric = trimmed.match(/^post:(\d+)$/)?.[1] ?? (/^\d+$/.test(trimmed) ? trimmed : null);
  if (postKeyRef) {
    const post = backendDb.db.select().from(posts).where(eq(posts.postKey, postKeyRef)).get();
    if (post) return { input: ref, postId: post.postId, postKey: post.postKey, messageId: post.messageId };
  }
  if (!numeric) return null;
  const id = Number(numeric);
  const publication = backendDb.db
    .select({ postId: publications.postId, telegramMessageId: publications.telegramMessageId })
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
  return post ? { input: ref, postId: post.postId, postKey: post.postKey, messageId: post.messageId } : null;
}

export function sourcePayload(backendDb: BackendDb, ref: PublicationRef): Record<string, unknown> {
  if (ref.postId != null) {
    const source = jsonObject(
      backendDb.db
        .select({ itemJson: publicationSources.itemJson })
        .from(publicationSources)
        .where(eq(publicationSources.postId, ref.postId))
        .get()?.itemJson,
    );
    if (Object.keys(source).length > 0) return source;
  }
  const siteSource = jsonObject(
    backendDb.db
      .select({ itemJson: siteSourceItems.itemJson })
      .from(siteSourceItems)
      .where(eq(siteSourceItems.messageId, ref.messageId))
      .get()?.itemJson,
  );
  if (Object.keys(siteSource).length > 0) return siteSource;
  return jsonObject(backendDb.db.select({ rawJson: posts.rawJson }).from(posts).where(eq(posts.postKey, ref.postKey)).get()?.rawJson);
}
