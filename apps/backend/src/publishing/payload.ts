import { isStoryTarget, targetLocale } from "../botTargets.js";
import { payloadMedia } from "../delivery/social/payload.js";

/** Resolves a draft's dual-locale payload to one target's locale, and
 * canonicalizes its media items (localPath/local_path, vpsUrl/vps_url, ...)
 * to their one camelCase shape at write time. Every consumer downstream
 * (delivery ports, media staging) can then read `media`/`media_en` directly
 * instead of re-running alias resolution on each read. */
export function localizeTargetPayload(payload: Record<string, unknown>, target: string): Record<string, unknown> {
  const locale = targetLocale(target) ?? "en";
  const storyMedia = isStoryTarget(target) ? payload[locale === "ru" ? "story_media_ru" : "story_media_en"] : undefined;
  if (locale === "ru") {
    const text = String(payload.text_ru ?? payload.text ?? "");
    const entities = recordArray(payload.entities_ru ?? payload.entities);
    const localized = {
      ...payload,
      locale,
      title: firstLine(text),
      text,
      text_ru: text,
      text_en: "",
      bodyMarkdown: text,
      media: storyMedia ?? payload.media,
      media_en: undefined,
      entities,
      slug: payload.slug_ru,
      slug_en: undefined,
    };
    return { ...localized, media: payloadMedia(localized), media_en: undefined };
  }

  const text = String(payload.text_en ?? payload.text ?? "");
  const entities = recordArray(payload.entities_en ?? payload.entities);
  const rawMedia = storyMedia ?? payload.media_en ?? payload.media;
  const localized = {
    ...payload,
    locale,
    title: firstLine(text),
    text,
    text_en: text,
    bodyMarkdown: text,
    media: rawMedia,
    media_en: rawMedia,
    entities,
    slug: payload.slug_en,
  };
  const media = payloadMedia(localized);
  return { ...localized, media, media_en: media };
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() || "Alex Getman update";
}
