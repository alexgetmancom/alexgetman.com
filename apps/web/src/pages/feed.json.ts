import { publicJsonFeedResponse } from "../server/public-feed";

export const prerender = false;

export function GET() {
  return publicJsonFeedResponse("en");
}
