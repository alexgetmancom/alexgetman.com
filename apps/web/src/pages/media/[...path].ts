import path from "node:path";
import type { APIRoute } from "astro";
import { getRuntime } from "../../server/runtime.js";

export const prerender = false;

function parseRange(value: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return "invalid";
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) return "invalid";
  return { start, end };
}

async function serveMedia(request: Request, params: { path?: string }, headOnly: boolean): Promise<Response> {
  const root = path.resolve(getRuntime().config.SITE_PUBLIC_DIR, "media");
  const relative = decodeURIComponent(params.path ?? "").replace(/^\/+/, "");
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return new Response("forbidden\n", { status: 403 });
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("not found\n", { status: 404 });

  const size = file.size;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=300",
  });
  if (file.type) headers.set("Content-Type", file.type);

  const range = parseRange(request.headers.get("range"), size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    const length = range.end - range.start + 1;
    headers.set("Content-Length", String(length));
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    return new Response(headOnly ? null : file.slice(range.start, range.end + 1), { status: 206, headers });
  }

  headers.set("Content-Length", String(size));
  return new Response(headOnly ? null : file, { headers });
}

export const GET: APIRoute = ({ request, params }) => serveMedia(request, params, false);
export const HEAD: APIRoute = ({ request, params }) => serveMedia(request, params, true);
