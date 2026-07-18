import { createApiHandler } from "../../../../backend/src/api.js";
import { getRuntime } from "../../server/runtime.js";

export const prerender = false;

const handle = ({ request }: { request: Request }) => createApiHandler(getRuntime())(request);

export const GET = handle;
export const POST = handle;
