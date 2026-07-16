import type { APIRoute } from "astro";
import { getRuntime } from "../../../../server/runtime.js";

/**
 * Public, short-lived source endpoint used by Meta while it imports a Reel.
 * Studio asset ids are intentionally resolved here instead of falling through
 * to the legacy `assetKey` route, which only knows VIDEO_MEDIA_DIR files.
 */
function mediaAssetResponse(id: string | undefined, headOnly: boolean): Response {
  if (!id || !/^\d+$/.test(id)) return new Response("Not found", { status: 404 });
  const asset = getRuntime()
    .backendDb.sqlite.prepare("SELECT kind, local_path AS localPath, mime_type AS mimeType FROM studio_media_assets WHERE id=?")
    .get(Number(id)) as { kind: string; localPath: string; mimeType: string | null } | null;
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
