export function siteUrlFromContext(context: { site?: URL | string | null }): string {
  return context.site ? context.site.toString().replace(/\/$/, "") : "https://alexgetman.com";
}
