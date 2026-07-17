import type { APIRoute } from "astro";
import { getRuntime } from "../../../../server/runtime.js";

/**
 * Public, short-lived source endpoint used by Meta while it imports a Reel.
 * Content-addressed by sha256 (matches videoPublicUrl): the asset id is a
 * small integer and would be trivially enumerable, exposing unpublished
 * Studio uploads.
 */
function mediaAssetResponse(id: string | undefined, headOnly: boolean): Response {
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return new Response("Not found", { status: 404 });
  const asset = getRuntime()
    .backendDb.sqlite.prepare("SELECT kind, local_path AS localPath, mime_type AS mimeType FROM studio_media_assets WHERE sha256=?")
    .get(id) as { kind: string; localPath: string; mimeType: string | null } | null;
  if (asset?.kind !== "video") return new Response("Not found", { status: 404 });
  const file = Bun.file(asset.localPath);
  if (file.size === 0) return new Response("Not found", { status: 404 });
  return new Response(headOnly ? null : file, {
    headers: {
      "Content-Type": asset.mimeType || "video/mp4",
      "Content-Length": String(file.size),
      "Cache-Control": "public, max-age=300",
      "Accept-Ranges": "bytes",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export const GET: APIRoute = ({ params }) => mediaAssetResponse(params.id, false);
export const HEAD: APIRoute = ({ params }) => mediaAssetResponse(params.id, true);
