import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { formatDate } from "../utils/dates";
import { keyEntities } from "../utils/key-entities";
import { localePath, SITE_LOCALE_TAGS, SITE_LOCALES, type SiteLocale } from "../utils/locale";
import { hasPublishedLocale, localizedHtml, localizedSlug, localizedText, sortedPublishedItems } from "../utils/public-feed";
import { siteUrlFromContext } from "../utils/site";
import { compactText, truncateText } from "../utils/text";
import { findFeedItem, loadFeedItems } from "./public-site";
import { getRuntime } from "./runtime";
import { fill, siteCopy } from "./site-copy";

const LLMS_POST_LIMIT = 30;

/** Absolute canonical URL of one post in one language. */
function postUrl(item: { post_id?: number | string | null }, slug: string, locale: SiteLocale, origin = siteUrlFromContext()): string {
  return `${origin}${localePath(locale, `/${item.post_id}/${slug}/`)}`;
}

/** The post's title, or a numbered fallback when its text opens with nothing usable. */
function postTitle(text: string, id: number | string | undefined | null, locale: SiteLocale, limit = 86): string {
  return truncateText(text, limit) || fill(siteCopy(locale).postFallback, { id: String(id ?? "") });
}

export async function publicRssResponse(context: APIContext, locale: SiteLocale): Promise<Response> {
  const items = sortedPublishedItems(loadFeedItems(), locale, 50);
  const copy = siteCopy(locale);

  return rss({
    title: copy.feedTitle,
    description: copy.feedDescription,
    site: siteUrlFromContext(context),
    items: items.map((item) => {
      const slug = localizedSlug(item, locale) ?? "";
      return {
        title: postTitle(localizedText(item, locale), item.post_id, locale),
        pubDate: new Date(item.date),
        description: localizedHtml(item, locale),
        link: localePath(locale, `/${item.post_id}/${slug}/`),
      };
    }),
    customData: `<language>${locale}</language>`,
  });
}

export function publicJsonFeedResponse(locale: SiteLocale): Response {
  const items = sortedPublishedItems(loadFeedItems(), locale, 50).map((item) => {
    if (locale === "ru") return item;
    return {
      ...item,
      text: item.text_en,
      html: item.html_en || item.text_en,
      media: Array.isArray(item.media_en) && item.media_en.length > 0 ? item.media_en : item.media,
      image: item.image_en || item.image,
      canonical_url: postUrl(item, item.slug_en ?? "", "en"),
      ru_url: hasPublishedLocale(item, "ru") ? postUrl(item, item.slug_ru ?? "", "ru") : null,
    };
  });

  return new Response(JSON.stringify({ items }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-Robots-Tag": "noindex, follow",
    },
  });
}

export function publicAiFeedResponse(locale: SiteLocale): Response {
  // sortedPublishedItems already orders newest-first and applies the cap.
  const items = sortedPublishedItems(loadFeedItems(), locale, 100).map((item) => {
    const text = compactText(localizedText(item, locale));
    const canonicalUrl = postUrl(item, localizedSlug(item, locale) ?? "", locale);
    return {
      id: `post:${item.post_id}`,
      title: truncateText(text, 100),
      tldr: truncateText(text, 280),
      key_entities: keyEntities(text),
      published_at: item.date,
      canonical_url: canonicalUrl,
      markdown_url: `${canonicalUrl.slice(0, -1)}.md`,
      // Every language this post also exists in, the current one excluded: the
      // reader is already holding that one.
      translations: Object.fromEntries(
        SITE_LOCALES.filter((other) => other !== locale && hasPublishedLocale(item, other)).map((other) => [
          other,
          postUrl(item, localizedSlug(item, other) ?? "", other),
        ]),
      ),
      actions: [],
    };
  });

  return new Response(JSON.stringify({ version: 1, updated_at: new Date().toISOString(), items }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-Robots-Tag": "noindex, follow",
    },
  });
}

export async function publicMarkdownResponse(context: APIContext, locale: SiteLocale): Promise<Response> {
  const found = findFeedItem(context.params.postId);
  const slug = found ? localizedSlug(found, locale) : null;
  const item = found && hasPublishedLocale(found, locale) && slug === context.params.slug ? found : undefined;
  if (!item || !slug) return new Response("Markdown file not found\n", { status: 404 });

  const siteUrl = siteUrlFromContext(context);
  const copy = siteCopy(locale);
  const text = localizedText(item, locale);
  const lines = [
    `# ${text.split("\n")[0] || postTitle("", item.post_id, locale)}`,
    "",
    `*${copy.publishedOn}: ${new Date(item.date).toUTCString()}*`,
    "",
    text,
    "",
    "---",
    `[${copy.backHome}](${siteUrl}${localePath(locale)}) | [${copy.viewArticle}](${postUrl(item, slug, locale, siteUrl)})`,
  ];

  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

/**
 * llms.txt: the link-shaped map of the site an agent reads first. Every entry
 * is a link, including the posts — a full-text dump belongs behind the `.md`
 * URLs each row points at, not in the index itself.
 */
export async function publicLlmsResponse(context: APIContext, locale: SiteLocale, contentType: string): Promise<Response> {
  const timeZone = getRuntime().config.TIMEZONE;
  const items = sortedPublishedItems(loadFeedItems(), locale);
  const copy = siteCopy(locale);
  const siteUrl = siteUrlFromContext(context);
  const others = SITE_LOCALES.filter((other) => other !== locale);

  const lines = [
    `# ${copy.llmsTitle}`,
    "",
    `> ${copy.llmsTagline}`,
    "",
    `## ${copy.headingAbout}`,
    "",
    copy.llmsAbout,
    "",
    `## ${copy.headingLinks}`,
    "",
    `- ${copy.labelWebsite}: ${siteUrl}${localePath(locale)}`,
    `- ${copy.labelJsonFeed}: ${siteUrl}${localePath(locale, "/feed.json")}`,
    `- ${copy.labelRss}: ${siteUrl}${localePath(locale, "/feed.xml")}`,
    `- ${copy.labelMarkdownIndex}: ${siteUrl}${localePath(locale, "/index.md")}`,
    ...others.flatMap((other) => [
      `- ${siteCopy(other).nativeName}: ${siteUrl}${localePath(other)}`,
      `- ${siteCopy(other).nativeName} ${siteCopy(other).labelRss}: ${siteUrl}${localePath(other, "/feed.xml")}`,
    ]),
    `- ${copy.labelSitemap}: ${siteUrl}/sitemap.xml`,
    "",
    `## ${copy.headingSocial}`,
    "",
    ...copy.social.map(([label, url]) => `- ${label}: ${url}`),
    "",
    `## ${copy.headingPosts}`,
    "",
  ];

  if (items.length === 0) {
    lines.push(`- ${copy.noPosts}`);
  } else {
    for (const item of items.slice(0, LLMS_POST_LIMIT)) {
      const slug = localizedSlug(item, locale);
      if (!slug) continue;
      const title = postTitle(localizedText(item, locale), item.post_id, locale);
      const date = formatDate(item.date, SITE_LOCALE_TAGS[locale], timeZone);
      lines.push(`- [${title}](${siteUrl}${localePath(locale, `/${item.post_id}/${slug}.md`)}) - ${date} MSK`);
    }
  }

  // One document, two addresses: /llms.txt by the convention's name, and
  // /index.md as the Markdown twin of the home page. They differ only in what
  // the caller says the body is, so the type is an argument rather than a
  // branch on which route arrived here.
  return new Response(`${lines.join("\n")}\n`, { headers: { "Content-Type": contentType } });
}
