import path from "node:path";
import type { APIRoute } from "astro";
import { rangedFileResponse } from "../../server/media-file.js";
import { getRuntime } from "../../server/runtime.js";

export const prerender = false;

async function serveMedia(request: Request, params: { path?: string }, headOnly: boolean): Promise<Response> {
  const requestedPath = decodeURIComponent(params.path ?? "").replace(/^\/+/, "");
  const isStaged = requestedPath === "staging" || requestedPath.startsWith("staging/");
  const root = isStaged ? path.resolve(getRuntime().config.REMOTE_MEDIA_PATH) : path.resolve(getRuntime().config.SITE_PUBLIC_DIR, "media");
  const relative = isStaged ? requestedPath.slice("staging".length).replace(/^\/+/, "") : requestedPath;
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return new Response("forbidden\n", { status: 403 });
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("not found\n", { status: 404 });

  const headers = new Headers({
    // Materialized post media keeps its name for the life of the post; a day of
    // client caching satisfies Lighthouse without pinning replaced files forever.
    "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
  });
  if (file.type) headers.set("Content-Type", file.type);
  return rangedFileResponse(file, request, { headers, headOnly });
}

export const GET: APIRoute = ({ request, params }) => serveMedia(request, params, false);
export const HEAD: APIRoute = ({ request, params }) => serveMedia(request, params, true);
