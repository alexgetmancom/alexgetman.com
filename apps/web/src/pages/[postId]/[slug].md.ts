import type { APIContext } from "astro";
import { publicMarkdownResponse } from "../../server/public-feed";

export const prerender = false;

export function GET(context: APIContext) {
  return publicMarkdownResponse(context, "en");
}
