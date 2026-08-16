import type { FeedItem } from "../server/public-site";
import { entityUrl } from "./entity-url";
import { postSocialImagePath, postVisualMedia } from "./media";
import { siteUrlFromContext } from "./site";

type SchemaLocale = "en" | "ru";

type PostSchemaInput = {
  item: FeedItem;
  locale: SchemaLocale;
  pageTitle: string;
  description: string;
  canonicalUrl: string;
};

/** The NewsArticle/VideoObject graph for a story page. Both locale routes render
 * the same graph shape and differ only in language, author name and hub URL —
 * keeping it in one place is what stops the two pages from drifting apart. */
export function buildPostSchema({ item, locale, pageTitle, description, canonicalUrl }: PostSchemaInput): string {
  const author = locale === "ru" ? "Алекс Гетман" : "Alex Getman";
  const authorUrl = locale === "ru" ? `${siteUrlFromContext()}/ru/` : `${siteUrlFromContext()}/`;
  const inLanguage = locale === "ru" ? "ru-RU" : "en-US";
  const ogImage = postSocialImagePath(item, locale);
  const visualMedia = postVisualMedia(item, locale);
  const primaryVideo = visualMedia?.type === "video" ? visualMedia : null;
  const about = item.entities.map((entity) => ({
    "@type": "Thing",
    name: locale === "ru" ? entity.title_ru : entity.title_en || entity.title_ru,
    url: `${siteUrlFromContext()}${entityUrl(entity.kind, entity.slug, locale)}`,
  }));
  const person = { "@type": "Person", name: author, url: authorUrl };

  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "NewsArticle",
        headline: pageTitle,
        description,
        url: canonicalUrl,
        datePublished: item.date,
        dateModified: item.date,
        inLanguage,
        author: person,
        publisher: person,
        mainEntityOfPage: canonicalUrl,
        image: [`${siteUrlFromContext()}${ogImage}`],
        ...(about.length > 0 ? { about } : {}),
      },
      ...(primaryVideo
        ? [
            {
              "@type": "VideoObject",
              name: pageTitle,
              description,
              thumbnailUrl: [`${siteUrlFromContext()}/${primaryVideo.poster || ogImage.replace(/^\//, "")}`],
              uploadDate: item.date,
              contentUrl: `${siteUrlFromContext()}/${primaryVideo.path}`,
              embedUrl: canonicalUrl,
              mainEntityOfPage: canonicalUrl,
              inLanguage,
            },
          ]
        : []),
    ],
  });
}
