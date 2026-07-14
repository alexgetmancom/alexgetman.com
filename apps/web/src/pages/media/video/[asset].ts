import type { APIRoute } from "astro";
import { videoPath } from "../../../../../backend/src/content/video-assets.js";
import { getRuntime } from "../../../server/runtime.js";

export const GET: APIRoute = ({ params }) => {
  const assetKey = params.asset;
  if (!assetKey || !/^[A-Za-z0-9_-]{16,64}$/.test(assetKey)) return new Response("Not found", { status: 404 });
  const runtime = getRuntime();
  const filePath = videoPath(runtime.config, assetKey);
  if (!filePath) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": "video/mp4", "Cache-Control": "private, max-age=300", "Accept-Ranges": "bytes" },
  });
};
