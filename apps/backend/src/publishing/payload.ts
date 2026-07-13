import { targetLocale } from "../botTargets.js";

export function localizeTargetPayload(payload: Record<string, unknown>, target: string): Record<string, unknown> {
  const locale = targetLocale(target) ?? "en";
  if (locale === "ru") {
    const text = String(payload.text_ru ?? payload.text ?? "");
    return {
      ...payload,
      locale,
      title: firstLine(text),
      text,
      text_en: "",
      bodyMarkdown: text,
      media: payload.media,
      media_en: undefined,
      entities: payload.entities_ru ?? payload.entities,
      slug: payload.slug_ru,
      slug_en: undefined,
    };
  }

  const text = String(payload.text_en ?? payload.text ?? "");
  const media = payload.media_en ?? payload.media;
  return {
    ...payload,
    locale,
    title: firstLine(text),
    text,
    text_en: text,
    bodyMarkdown: text,
    media,
    media_en: media,
    entities: payload.entities_en ?? payload.entities,
    slug: payload.slug_en,
  };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() || "Alex Getman update";
}
