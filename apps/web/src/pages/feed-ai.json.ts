import { publicAiFeedResponse } from "../server/public-feed";

export const prerender = false;

export function GET() {
  return publicAiFeedResponse("en");
}
