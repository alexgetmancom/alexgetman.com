import type { APIContext } from "astro";
import { publicLlmsResponse } from "../server/public-feed";

export const prerender = false;

export function GET(context: APIContext) {
  return publicLlmsResponse(context, "en", "text/plain; charset=utf-8");
}
