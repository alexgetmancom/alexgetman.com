import { eq } from "drizzle-orm";
import { targetLocale } from "../botTargets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { posts, publicationTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { createPlatformAdapters } from "./platform-adapters.js";

type PublishedTargetEdit = { publicationKey: string; textRu: string | null; textEn: string | null; target?: string; locale?: "ru" | "en" };

/** Delivery gateway for best-effort edits of content that has already left this system. */
export async function editPublishedTargets(
  backendDb: BackendDb,
  edit: PublishedTargetEdit,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<Record<string, unknown>>> {
  const post = unsafeDb(backendDb)
    .db.select({ chatId: posts.chatId, mediaCount: posts.mediaCount })
    .from(posts)
    .where(eq(posts.publicationKey, edit.publicationKey))
    .get();
  const rows = unsafeDb(backendDb)
    .db.select({
      target: publicationTargets.target,
      status: publicationTargets.status,
      externalId: publicationTargets.externalId,
      externalIdsJson: publicationTargets.externalIdsJson,
    })
    .from(publicationTargets)
    .where(eq(publicationTargets.publicationKey, edit.publicationKey))
    .all();
  const editable = rows
    .filter((row): row is typeof row & { externalId: string } => row.status === "published" && row.externalId != null)
    .filter((row) => !edit.target || row.target === edit.target)
    .filter((row) => !edit.locale || targetLocale(row.target) === edit.locale);
  const adapters = createPlatformAdapters(config, fetchImpl);
  const results = await Promise.all(
    editable.map(async (row): Promise<Record<string, unknown> | null> => {
      try {
        const adapter = adapters[row.target];
        const text = targetLocale(row.target) === "ru" ? edit.textRu : edit.textEn;
        if (!adapter?.edit || !text) return { target: row.target, ok: false, skipped: true, error: "no_edit_port_for_target" };
        const result = await adapter.edit({
          externalId: row.externalId,
          text,
          ...(post?.chatId ? { chatId: post.chatId } : {}),
          mediaCount: Number(post?.mediaCount ?? 0),
          externalIdCount: row.externalIdsJson?.length ?? 1,
        });
        return { target: row.target, ...result };
      } catch (error) {
        return { target: row.target, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return results.filter((result): result is Record<string, unknown> => result != null);
}
