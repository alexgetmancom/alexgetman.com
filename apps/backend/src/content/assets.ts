import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { studioMediaAssets } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";

type StudioMediaKind = "photo" | "video";

type ImportedStudioMedia = {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  source: "mcp_upload" | "http_upload" | "telegram_upload";
};

type ImportedStudioMediaFile = Omit<ImportedStudioMedia, "bytes"> & { localPath: string; byteSize?: number };

/** Content-owned file storage. Interfaces hand it bytes; delivery later decides how to upload them. */
export async function importStudioMediaAsset(backendDb: BackendDb, config: BackendConfig, actorId: number, input: ImportedStudioMedia) {
  if (input.bytes.byteLength === 0) throw new Error("Media file is empty.");
  assertStudioMediaSize(input.bytes.byteLength, config.STUDIO_MEDIA_MAX_BYTES);
  const temporary = path.join(config.STUDIO_MEDIA_DIR, ".incoming", `${crypto.randomUUID()}`);
  await fs.promises.mkdir(path.dirname(temporary), { recursive: true });
  await fs.promises.writeFile(temporary, input.bytes);
  try {
    return await importStudioMediaFile(backendDb, config, actorId, { ...input, localPath: temporary, byteSize: input.bytes.byteLength });
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

/** Streams/copies an already downloaded file into Content storage without loading it into application memory. */
export async function importStudioMediaFile(backendDb: BackendDb, config: BackendConfig, actorId: number, input: ImportedStudioMediaFile) {
  const stat = await fs.promises.stat(input.localPath);
  const byteSize = input.byteSize ?? stat.size;
  if (byteSize === 0) throw new Error("Media file is empty.");
  assertStudioMediaSize(byteSize, config.STUDIO_MEDIA_MAX_BYTES);
  const kind = mediaKind(input.contentType, input.filename);
  if (!kind) throw new Error("Only image and MP4 video uploads are supported.");
  const extension = mediaExtension(kind, input.contentType, input.filename);
  const sha256 = await fileSha256(input.localPath);
  const filename = `${sha256.slice(0, 24)}${extension}`;
  const directory = path.join(config.STUDIO_MEDIA_DIR, String(actorId));
  const localPath = path.join(directory, filename);
  await fs.promises.mkdir(directory, { recursive: true });
  if (!fs.existsSync(localPath)) {
    // Copy rather than link/rename: callers keep ownership of `input.localPath`
    // (a bot-api download, a caller temp file), and the chmod below would
    // otherwise reach through a shared inode into a file that is not ours.
    await fs.promises.copyFile(input.localPath, localPath);
    await fs.promises.chmod(localPath, 0o640);
  }
  const now = new Date().toISOString();
  const existing = backendDb.db
    .select()
    .from(studioMediaAssets)
    .where(and(eq(studioMediaAssets.actorId, actorId), eq(studioMediaAssets.sha256, sha256)))
    .get();
  // The insert is guarded by the unique (actor_id, sha256) index rather than by
  // the lookup above: two concurrent imports of one file both miss the select.
  // `onConflictDoNothing` + re-read makes the loser adopt the winner's row.
  const inserted = existing
    ? undefined
    : backendDb.db
        .insert(studioMediaAssets)
        .values({
          actorId,
          kind,
          mimeType: input.contentType || (kind === "video" ? "video/mp4" : "image/jpeg"),
          filename: safeFilename(input.filename) || filename,
          localPath,
          byteSize,
          sha256,
          source: input.source,
          createdAt: now,
        })
        .onConflictDoNothing({ target: [studioMediaAssets.actorId, studioMediaAssets.sha256] })
        .returning()
        .get();
  const asset =
    existing ??
    inserted ??
    backendDb.db
      .select()
      .from(studioMediaAssets)
      .where(and(eq(studioMediaAssets.actorId, actorId), eq(studioMediaAssets.sha256, sha256)))
      .get();
  if (!asset) throw new Error("Media asset could not be stored.");
  // Only the import that actually created the row announces it: a lost race and
  // a plain re-upload are both "this asset already exists", not a new import.
  if (inserted)
    recordDomainEvent(backendDb, {
      ref: `asset:${asset.id}`,
      type: "content.media.imported",
      severity: "info",
      message: `Studio media asset #${asset.id} imported`,
      details: { owner_id: actorId, kind, byte_size: byteSize, source: input.source },
    });
  return asset;
}

export function listStudioMediaAssets(backendDb: BackendDb, actorId: number, limit = 50) {
  return backendDb.db
    .select()
    .from(studioMediaAssets)
    .where(eq(studioMediaAssets.actorId, actorId))
    .orderBy(studioMediaAssets.id)
    .limit(limit)
    .all();
}

export function requireStudioMediaAssets(backendDb: BackendDb, actorId: number, assetIds: number[]) {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return [];
  const assets = backendDb.db
    .select()
    .from(studioMediaAssets)
    .where(and(eq(studioMediaAssets.actorId, actorId), inArray(studioMediaAssets.id, ids)))
    .all();
  if (assets.length !== ids.length) throw new Error("One or more media assets are not available to this owner.");
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return ids.map((id) => byId.get(id)).filter((asset): asset is (typeof assets)[number] => asset != null);
}

export function mediaItemsFromAssets(assets: ReturnType<typeof requireStudioMediaAssets>): Record<string, unknown>[] {
  return assets.map((asset) => ({
    type: asset.kind,
    asset_id: asset.id,
    local_path: asset.localPath,
    filename: asset.filename,
    mime_type: asset.mimeType,
  }));
}

function mediaKind(contentType: string, filename: string): StudioMediaKind | null {
  const value = contentType.toLowerCase();
  if (value.startsWith("image/")) return "photo";
  if (value === "video/mp4") return "video";
  const extension = path.extname(filename).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"].includes(extension)) return "photo";
  return extension === ".mp4" ? "video" : null;
}

function mediaExtension(kind: StudioMediaKind, contentType: string, filename: string): string {
  const existing = path.extname(filename).toLowerCase();
  if (kind === "video") return ".mp4";
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"].includes(existing)) return existing === ".jpeg" ? ".jpg" : existing;
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "image/gif") return ".gif";
  return ".jpg";
}

function safeFilename(value: string): string {
  return path
    .basename(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 180);
}

function formatMegabytes(bytes: number): number {
  return Math.ceil(bytes / 1024 / 1024);
}

function assertStudioMediaSize(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes)
    throw new Error(`Media file is ${formatMegabytes(bytes)} MB; Studio accepts files up to ${formatMegabytes(maxBytes)} MB.`);
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
