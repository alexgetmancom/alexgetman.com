import { isStoryTarget, targetLocale } from "../botTargets.js";
import { firstLine } from "../content/message.js";
import { payloadMedia } from "../delivery/social/payload.js";
import { selectMediaForTarget } from "./media-policy.js";

/** Resolves the dual-locale publication source into the one durable job shape. */
export function localizeTargetPayload(payload: Record<string, unknown>, target: string): Record<string, unknown> {
  const locale = targetLocale(target) ?? "en";
  const storyMedia = isStoryTarget(target) ? payload[locale === "ru" ? "story_media_ru" : "story_media_en"] : undefined;
  if (locale === "ru") {
    const text = String(payload.text_ru ?? payload.text ?? "");
    const entities = recordArray(payload.entities_ru ?? payload.entities);
    const rawMedia = storyMedia ?? payload.media;
    const selectedMedia = Array.isArray(rawMedia) ? selectMediaForTarget(target, rawMedia).map(deliveryMedia) : rawMedia;
    const localized = {
      locale,
      title: firstLine(text),
      text,
      media: selectedMedia,
      entities,
      slug: payload.slug_ru,
      postId: payload.post_id,
      draftId: payload.draft_id,
      threadsChainApproved: payload.threads_chain_approved === true,
    };
    return { ...localized, media: payloadMedia(localized) };
  }

  const text = String(payload.text_en ?? payload.text ?? "");
  const entities = recordArray(payload.entities_en ?? payload.entities);
  const rawMedia = storyMedia ?? payload.media_en ?? payload.media;
  const selectedMedia = Array.isArray(rawMedia) ? selectMediaForTarget(target, rawMedia).map(deliveryMedia) : rawMedia;
  const localized = {
    locale,
    title: firstLine(text),
    text,
    media: selectedMedia,
    entities,
    slug: payload.slug_en,
    postId: payload.post_id,
    draftId: payload.draft_id,
    threadsChainApproved: payload.threads_chain_approved === true,
  };
  return { ...localized, media: payloadMedia(localized) };
}

/** Translates the persisted Studio/Telegram media record into the one shape
 * stored on delivery jobs. Provider code never reads persistence field names. */
function deliveryMedia(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const media = value as Record<string, unknown>;
  return {
    type: media.type,
    fileId: media.fileId ?? media.file_id,
    localPath: media.localPath ?? media.local_path ?? media.path,
    vpsUrl: media.vpsUrl ?? media.vps_url ?? media.public_url,
    token: media.token,
    storyLocalPath: media.storyLocalPath ?? media.story_local_path,
    telegramStoryLocalPath: media.telegramStoryLocalPath ?? media.telegram_story_local_path,
    storyVpsUrl: media.storyVpsUrl ?? media.story_vps_url,
  };
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}
