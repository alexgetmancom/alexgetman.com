import type { MiddlewareHandler } from "astro";

/** Home pages advertise the machine-readable entry points RFC 9727 defines, so
 * an agent can find the API catalog and the service doc without scraping HTML. */
const LINK_HEADER = '</.well-known/api-catalog>; rel="api-catalog", </llms.txt>; rel="service-doc"';
const LINKED_PAGES = new Set(["/", "/ru/"]);

/** Operator surfaces. They authenticate, but a crawler that indexes the login
 * screen turns a private page into a search result. */
const UNINDEXED = /^\/(command-center|stats|api\/command-center)(\/|$)/;

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

  if (prefersMarkdown(context.request.headers.get("accept"))) {
    const twin = markdownTwin(pathname);
    if (twin) return context.rewrite(twin);
  }

  const response = await next();
  if (LINKED_PAGES.has(pathname)) response.headers.set("Link", LINK_HEADER);
  if (UNINDEXED.test(pathname)) response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
};
