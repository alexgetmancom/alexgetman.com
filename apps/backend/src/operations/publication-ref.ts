import { eq, or } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { posts, publicationSources, publications } from "../db/schema.js";
import { jsonObject } from "../json.js";

export type ResolvedPublicationRef = { input: string; postId: number | null; postKey: string; messageId: number };

/** Resolves external command input to the stable publication identity used by Operations commands. */
export function resolvePublicationRef(backendDb: BackendDb, ref: string): ResolvedPublicationRef | null {
  const trimmed = ref.trim();
  const postKeyRef = trimmed.startsWith("post:") ? trimmed : null;
  const numeric = trimmed.match(/^post:(\d+)$/)?.[1] ?? (/^\d+$/.test(trimmed) ? trimmed : null);
  if (postKeyRef) {
    const post = unsafeDb(backendDb).db.select().from(posts).where(eq(posts.postKey, postKeyRef)).get();
    if (post) return { input: ref, postId: post.postId, postKey: post.postKey, messageId: post.messageId };
  }
  if (!numeric) return null;
  const id = Number(numeric);
  const publication = unsafeDb(backendDb)
    .db.select({ postId: publications.postId })
    .from(publications)
    .where(eq(publications.postId, id))
    .get();
  if (publication) {
    const post = unsafeDb(backendDb)
      .db.select()
      .from(posts)
      .where(eq(posts.postKey, `post:${publication.postId}`))
      .get();
    return {
      input: ref,
      postId: publication.postId,
      postKey: `post:${publication.postId}`,
      messageId: post?.messageId ?? publication.postId,
    };
  }
  const post = unsafeDb(backendDb)
    .db.select()
    .from(posts)
    .where(or(eq(posts.messageId, id), eq(posts.postId, id), eq(posts.postKey, `post:${id}`)))
    .get();
  return post ? { input: ref, postId: post.postId, postKey: post.postKey, messageId: post.messageId } : null;
}

export function sourcePayload(backendDb: BackendDb, ref: ResolvedPublicationRef): Record<string, unknown> {
  if (ref.postId == null) throw new Error("publication has no post id");
  const source = jsonObject(
    unsafeDb(backendDb)
      .db.select({ itemJson: publicationSources.itemJson })
      .from(publicationSources)
      .where(eq(publicationSources.postId, ref.postId))
      .get()?.itemJson,
  );
  if (Object.keys(source).length === 0) throw new Error(`publication ${ref.postId} has no source payload`);
  return source;
}
