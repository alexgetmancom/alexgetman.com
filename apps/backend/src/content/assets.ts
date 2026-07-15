import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { studioMediaAssets } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";

export type StudioMediaKind = "photo" | "video";

export type ImportedStudioMedia = {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  source: "mcp_upload" | "http_upload";
};

/** Content-owned file storage. Interfaces hand it bytes; delivery later decides how to upload them. */
export async function importStudioMediaAsset(backendDb: BackendDb, config: BackendConfig, adminId: number, input: ImportedStudioMedia) {
  if (input.bytes.byteLength === 0) throw new Error("Media file is empty.");
  if (input.bytes.byteLength > config.STUDIO_MEDIA_MAX_BYTES) throw new Error("Media file exceeds the Studio upload limit.");
  const kind = mediaKind(input.contentType, input.filename);
  if (!kind) throw new Error("Only image and MP4 video uploads are supported.");
  const extension = mediaExtension(kind, input.contentType, input.filename);
  const sha256 = crypto.createHash("sha256").update(input.bytes).digest("hex");
  const filename = `${sha256.slice(0, 24)}${extension}`;
  const directory = path.join(config.STUDIO_MEDIA_DIR, String(adminId));
  const localPath = path.join(directory, filename);
  await fs.promises.mkdir(directory, { recursive: true });
  if (!fs.existsSync(localPath)) {
    await fs.promises.writeFile(localPath, input.bytes);
    await fs.promises.chmod(localPath, 0o640);
  }
  const now = new Date().toISOString();
  const existing = backendDb.db
    .select()
    .from(studioMediaAssets)
    .where(and(eq(studioMediaAssets.adminId, adminId), eq(studioMediaAssets.sha256, sha256)))
    .get();
  const asset =
    existing ??
    backendDb.db
      .insert(studioMediaAssets)
      .values({
        adminId,
        kind,
        mimeType: input.contentType || (kind === "video" ? "video/mp4" : "image/jpeg"),
        filename: safeFilename(input.filename) || filename,
        localPath,
        byteSize: input.bytes.byteLength,
        sha256,
        source: input.source,
        createdAt: now,
      })
      .returning()
      .get();
  if (!asset) throw new Error("Media asset could not be stored.");
  if (!existing)
    recordDomainEvent(backendDb, {
      ref: `asset:${asset.id}`,
      type: "content.media.imported",
      severity: "info",
      message: `Studio media asset #${asset.id} imported`,
      details: { owner_id: adminId, kind, byte_size: input.bytes.byteLength, source: input.source },
    });
  return asset;
}

export function listStudioMediaAssets(backendDb: BackendDb, adminId: number, limit = 50) {
  return backendDb.db
    .select()
    .from(studioMediaAssets)
    .where(eq(studioMediaAssets.adminId, adminId))
    .orderBy(studioMediaAssets.id)
    .limit(limit)
    .all();
}

export function requireStudioMediaAssets(backendDb: BackendDb, adminId: number, assetIds: number[]) {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return [];
  const assets = backendDb.db
    .select()
    .from(studioMediaAssets)
    .where(and(eq(studioMediaAssets.adminId, adminId), inArray(studioMediaAssets.id, ids)))
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
