import { createApiHandler } from "../../../../backend/src/api.js";
import { getRuntime } from "../../server/runtime.js";
export const prerender = false;
export const GET = ({ request }: { request: Request }) => createApiHandler(getRuntime())(request, "/stats");
