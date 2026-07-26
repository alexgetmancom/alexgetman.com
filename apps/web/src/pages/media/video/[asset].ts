import type { APIRoute } from "astro";
import { videoPath } from "../../../../../backend/src/content/video-assets.js";
import { rangedFileResponse } from "../../../server/media-file.js";
import { getRuntime } from "../../../server/runtime.js";

async function serveVideo(request: Request, assetKey: string | undefined, headOnly: boolean): Promise<Response> {
  if (!assetKey || !/^[A-Za-z0-9_-]{16,64}$/.test(assetKey)) return new Response("Not found", { status: 404 });
  const runtime = getRuntime();
  const filePath = videoPath(runtime.config, assetKey);
  if (!filePath) return new Response("Not found", { status: 404 });
  const file = Bun.file(filePath);
  // videoPath only proves a directory entry existed at scan time; without this
  // check a pruned source streams as a truncated 200 instead of a clean 404.
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return rangedFileResponse(file, request, {
    headers: { "Content-Type": "video/mp4", "Cache-Control": "private, max-age=300" },
    headOnly,
  });
}

export const GET: APIRoute = ({ request, params }) => serveVideo(request, params.asset, false);
export const HEAD: APIRoute = ({ request, params }) => serveVideo(request, params.asset, true);
