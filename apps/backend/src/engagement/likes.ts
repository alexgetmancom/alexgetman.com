import { and, eq, inArray, sql } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { likes } from "../db/schema.js";

export function likesInfo(backendDb: BackendDb, postId: string, clientHash: string): { likes: number; user_liked: boolean } {
  const count = backendDb.db.select({ count: sql<number>`count(*)` }).from(likes).where(eq(likes.postId, postId)).get();
  const liked = backendDb.db
    .select({ postId: likes.postId })
    .from(likes)
    .where(and(eq(likes.postId, postId), eq(likes.ipHash, clientHash)))
    .get();
  return { likes: Number(count?.count ?? 0), user_liked: Boolean(liked) };
}

export function batchLikes(
  backendDb: BackendDb,
  postIds: string[],
  clientHash: string,
): Record<string, { likes: number; user_liked: boolean }> {
  if (postIds.length === 0) return {};
  const unique = [...new Set(postIds)];
  const rows = backendDb.db
    .select({
      postId: likes.postId,
      count: sql<number>`count(*)`,
      userLiked: sql<number>`max(case when ${likes.ipHash} = ${clientHash} then 1 else 0 end)`,
    })
    .from(likes)
    .where(inArray(likes.postId, unique))
    .groupBy(likes.postId)
    .all();
  const values = new Map(rows.map((row) => [row.postId, { likes: Number(row.count), user_liked: Number(row.userLiked) > 0 }]));
  return Object.fromEntries(unique.map((postId) => [postId, values.get(postId) ?? { likes: 0, user_liked: false }]));
}

export function toggleLike(backendDb: BackendDb, postId: string, clientHash: string): { likes: number; user_liked: boolean } {
  backendDb.db.transaction((tx) => {
    const exists = tx
      .select({ postId: likes.postId })
      .from(likes)
      .where(and(eq(likes.postId, postId), eq(likes.ipHash, clientHash)))
      .get();
    if (exists)
      tx.delete(likes)
        .where(and(eq(likes.postId, postId), eq(likes.ipHash, clientHash)))
        .run();
    else tx.insert(likes).values({ postId, ipHash: clientHash }).run();
  });
  return likesInfo(backendDb, postId, clientHash);
}
