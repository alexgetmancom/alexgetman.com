export const prerender = false;

/** Legacy @astrojs/sitemap URL kept alive for crawlers that still have it
 * registered (robots.txt used to advertise it). The canonical sitemap lives
 * at /sitemap.xml. */
export async function GET() {
  return new Response(null, { status: 301, headers: { Location: "/sitemap.xml" } });
}
