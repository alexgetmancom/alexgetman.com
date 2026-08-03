import { parseArrayValue } from "./message.js";

export type DraftLocale = "ru" | "en";

export type DraftLocaleContent = {
  text: string;
  entities: Record<string, unknown>[];
  media: Record<string, unknown>[];
};

export type DraftContentSource = {
  text_ru?: string | null;
  text_en_approved?: string | null;
  text_en_machine?: string | null;
  text_ru_entities_json?: unknown;
  text_en_entities_json?: unknown;
  media_ru_json?: unknown;
  media_en_json?: unknown;
};

/** Resolves the content that a locale actually receives at delivery time. */
export function draftLocaleContent(draft: DraftContentSource, locale: DraftLocale): DraftLocaleContent {
  const ruMedia = parseArrayValue(draft.media_ru_json);
  if (locale === "ru") {
    return {
      text: String(draft.text_ru ?? ""),
      entities: parseArrayValue(draft.text_ru_entities_json),
      media: ruMedia,
    };
  }

  const enMedia = parseArrayValue(draft.media_en_json);
  return {
    text: String(draft.text_en_approved ?? draft.text_en_machine ?? draft.text_ru ?? ""),
    entities: parseArrayValue(draft.text_en_entities_json),
    media: enMedia.length ? enMedia : ruMedia,
  };
}
