import { createApiHandler } from "../../../../backend/src/api.js";
import { getRuntime } from "../../server/runtime.js";

export const prerender = false;

async function handle(request: Request, route: string | undefined): Promise<Response> {
  const runtime = getRuntime();
  return createApiHandler(runtime)(request, `/api/${route ?? ""}`.replace(/\/$/, ""));
}

export const GET = ({ request, params }: { request: Request; params: { route?: string } }) => handle(request, params.route);
export const POST = ({ request, params }: { request: Request; params: { route?: string } }) => handle(request, params.route);
