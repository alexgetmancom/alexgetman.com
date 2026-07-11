import path from "node:path";
import { getRuntime } from "../../server/runtime.js";

export const prerender = false;

export async function GET({ params }: { params: { path?: string } }): Promise<Response> {
  const root = path.resolve(getRuntime().config.SITE_PUBLIC_DIR, "media");
  const relative = decodeURIComponent(params.path ?? "").replace(/^\/+/, "");
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return new Response("forbidden\n", { status: 403 });
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("not found\n", { status: 404 });
  return new Response(file, { headers: file.type ? { "content-type": file.type } : undefined });
}
