import { createApiHandler } from "../../../../backend/src/api.js";
import { getRuntime } from "../../server/runtime.js";
export const prerender = false;
export const POST = ({ request }: { request: Request }) => createApiHandler(getRuntime())(request, getRuntime().config.WEBHOOK_PATH);
