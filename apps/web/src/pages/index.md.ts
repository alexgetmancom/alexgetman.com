import type { APIContext } from "astro";
import { publicLlmsResponse } from "../server/public-feed";

export const prerender = false;

export function GET(context: APIContext) {
  return publicLlmsResponse(context, "en", "text/markdown; charset=utf-8");
}
