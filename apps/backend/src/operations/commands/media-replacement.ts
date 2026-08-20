import path from "node:path";
import { eq } from "drizzle-orm";
import { mediaItemsFromAssets } from "../../content/assets.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { drafts } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { createStudioServices } from "../../studio/services/index.js";
import { resolvePublicationRef } from "../publication-ref.js";
import { createOperationsService } from "../service.js";

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
};

/** Swaps the media a published post carries in one locale: the file on this host
 * becomes a Content asset, the target is deleted and queued again, and the site
 * re-renders from the new asset. A target is required — a locale-wide swap would
 * also take down the Telegram channel post, which is rarely what is meant. */
export async function replacePublishedMedia(
  backendDb: BackendDb,
  config: BackendConfig,
  input: { ref: string; locale: "ru" | "en"; file: string; target: string; apply: boolean },
  fetchImpl: typeof fetch,
  actorType: string,
): Promise<Record<string, unknown>> {
  const ref = resolvePublicationRef(backendDb, input.ref);
  if (!ref) throw new Error(`publication not found: ${input.ref}`);
  if (ref.postId == null) throw new Error(`media replacement requires a Studio post ref: ${input.ref}`);
  const draft = unsafeDb(backendDb).db.select({ actorId: drafts.actorId }).from(drafts).where(eq(drafts.postId, ref.postId)).get();
  if (!draft) throw new Error(`draft not found for publication: ${ref.publicationKey}`);
  // The scope report comes before the file is imported: a plan should not leave
  // an asset behind for a replacement the caller may never ask for.
  if (!input.apply)
    return createOperationsService(backendDb, config).command(
      { action: "replace_media", ref: input.ref, locale: input.locale, target: input.target },
      fetchImpl,
    );
  const filename = path.basename(input.file);
  const asset = await createStudioServices(backendDb, config).media.importFile(draft.actorId, {
    filename,
    contentType: IMAGE_TYPES[path.extname(filename).toLowerCase()] ?? "",
    localPath: input.file,
    source: "ops_upload",
  });
  const result = await createOperationsService(backendDb, config).command(
    {
      action: "replace_media",
      ref: input.ref,
      locale: input.locale,
      target: input.target,
      apply: true,
      media_json: JSON.stringify(mediaItemsFromAssets([asset])),
      actor_type: actorType,
    },
    fetchImpl,
  );
  return { ...result, asset_id: asset.id, filename: asset.filename, byte_size: asset.byteSize };
}
