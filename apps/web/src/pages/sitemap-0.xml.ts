export const prerender = false;

/** Legacy @astrojs/sitemap chunk URL; redirects to the canonical /sitemap.xml. */
export async function GET() {
  return new Response(null, { status: 301, headers: { Location: "/sitemap.xml" } });
}
