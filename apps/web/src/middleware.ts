import type { MiddlewareHandler } from "astro";
import { getRuntime } from "./server/runtime";

/** Home pages advertise the machine-readable entry points RFC 9727 defines, so
 * an agent can find the API catalog and the service doc without scraping HTML. */
const LINK_HEADER = '</.well-known/api-catalog>; rel="api-catalog", </llms.txt>; rel="service-doc"';
const LINKED_PAGES = new Set(["/", "/ru/"]);

/** Operator surfaces. They authenticate, but a crawler that indexes the login
 * screen turns a private page into a search result. */
const UNINDEXED = /^\/(command-center|oauth|stats|api\/command-center)(\/|$)/;

/** What a Studio without a public site still answers: the operator surfaces, the
 * agent transport, the health probes, and the media URL a publishing platform
 * fetches a video from. Everything else does not exist there.
 *
 * This lives here rather than in the proxy because `site_enabled: false` has to
 * mean the same thing for every install. It used to be enforced by one
 * deployment's allowlist, so the setting switched off the site workers while the
 * pages, feeds and sitemap carried on being served to anyone who asked. */
const WITHOUT_SITE =
  /^\/(command-center|oauth|healthz|readyz|api\/(command-center|mcp|studio\/media)|stats|tg-feed|media\/video\/asset)(\/|$)/;

/** Every post and index page has a Markdown twin at the same address plus
 * ".md". A client that asks for Markdown gets it at the canonical URL rather
 * than having to know the naming rule. */
function markdownTwin(pathname: string): string | undefined {
  // A rewrite re-enters this middleware, and the twin of a page is itself a
  // path this pattern matches. Without this guard the request rewrites forever
  // and Astro answers 508.
  if (pathname.endsWith(".md")) return undefined;
  if (pathname === "/") return "/index.md";
  if (pathname === "/ru/") return "/ru/index.md";
  const post = /^(\/ru)?\/(\d+)\/([^/]+)\/?$/.exec(pathname);
  return post ? `${post[1] ?? ""}/${post[2]}/${post[3]}.md` : undefined;
}

function prefersMarkdown(accept: string | null): boolean {
  return accept?.includes("text/markdown") ?? false;
}

export const onRequest: MiddlewareHandler = async (context, next) => {
  const { pathname } = context.url;

  if (!getRuntime().config.studio.siteEnabled && !WITHOUT_SITE.test(pathname)) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (prefersMarkdown(context.request.headers.get("accept"))) {
    const twin = markdownTwin(pathname);
    if (twin) return context.rewrite(twin);
  }

  const response = await next();
  if (LINKED_PAGES.has(pathname)) response.headers.set("Link", LINK_HEADER);
  if (UNINDEXED.test(pathname)) response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
};
