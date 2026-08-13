/** The origin this install answers on. `astro.config.ts` fixes `site` at build
 * time, which is right for the canonical deployment and wrong for every other
 * one — a self-hosted Studio serves the same image from its own domain. The
 * runtime value wins so feeds, robots.txt and the discovery documents all name
 * the host the request actually reached. */
export function siteUrlFromContext(context: { site?: URL | string | null }): string {
  const runtime = Bun.env.PUBLIC_BASE_URL?.trim();
  const configured = runtime || context.site?.toString() || "https://alexgetman.com";
  return configured.replace(/\/$/, "");
}
