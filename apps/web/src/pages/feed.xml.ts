import type { APIContext } from "astro";
import { publicRssResponse } from "../server/public-feed";

export const prerender = false;

export function GET(context: APIContext) {
  return publicRssResponse(context, "en");
}
