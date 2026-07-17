import { eq } from "drizzle-orm";
import { targetLocale } from "../botTargets.js";
import { parseArrayValue } from "../content/message.js";
import type { BackendDb } from "../db/client.js";
import { studioMediaAssets } from "../db/schema.js";
import { mediaPolicyForTarget } from "../publishing/media-policy.js";
import { formatPlatformText, platformProfile } from "../publishing/platform-profiles.js";
import { parseTargets } from "../publishing/targets.js";
import { getVideoDraft, listVideoTargets } from "../publishing/video-data.js";

export type DeliveryProjection = {
  id: string;
  label: string;
  targets: string[];
  locale?: "ru" | "en";
  text: string;
  media: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
  notes: string[];
};

/** Pure delivery-facing view shared by Telegram previews, MCP and future CLI. */
export function postDeliveryProjections(draft: {
  id: number;
  text_ru: string;
  text_en_approved: string | null;
  text_en_machine: string | null;
  media_ru_json: string | null;
  media_en_json: string | null;
  targets_json: string;
}) {
  const targets = Object.entries(parseTargets(draft.targets_json)).flatMap(([target, enabled]) => (enabled ? [target] : []));
  const content = {
    ru: { text: draft.text_ru, media: parseArrayValue(draft.media_ru_json) },
    en: {
      text: draft.text_en_approved ?? draft.text_en_machine ?? draft.text_ru,
      media: (() => {
        const value = parseArrayValue(draft.media_en_json);
        return value.length ? value : parseArrayValue(draft.media_ru_json);
      })(),
    },
  } as const;
  // One platform-specific deviation note per locale, not a whole separate
  // preview message per platform: with a dozen-plus targets, most differing
  // only by a character limit or a dropped video, a full resend of the media
  // for every single one buried the two previews that actually matter.
  const deviationNotes: Record<"ru" | "en", string[]> = { ru: [], en: [] };
  for (const target of targets) {
    const locale = targetLocale(target) ?? "en";
    const profile = platformProfile(target);
    const text = formatPlatformText(target, content[locale].text);
    const mediaPolicy = mediaPolicyForTarget(target, content[locale].media);
    const notes = [
      ...(text !== content[locale].text ? ["text is shortened/transformed for this platform"] : []),
      ...(mediaPolicy.note ? [mediaPolicy.note] : []),
    ];
    if (notes.length) deviationNotes[locale].push(`${profile?.label ?? target}: ${notes.join("; ")}`);
  }
  const canonical = (["ru", "en"] as const).flatMap((locale) => {
    const selected = targets.filter((target) => targetLocale(target) === locale);
    if (!selected.length) return [];
    return [
      {
        id: `post:${draft.id}:${locale}`,
        label: `Preview · ${locale.toUpperCase()}`,
        targets: selected,
        locale,
        text: content[locale].text,
        media: content[locale].media,
        notes: deviationNotes[locale],
      } satisfies DeliveryProjection,
    ];
  });
  return { kind: "post" as const, draftId: draft.id, projections: canonical };
}

export function videoDeliveryProjections(backendDb: BackendDb, videoDraftId: number) {
  const draft = getVideoDraft(backendDb, videoDraftId);
  const asset =
    draft.studioMediaAssetId == null
      ? null
      : backendDb.db.select().from(studioMediaAssets).where(eq(studioMediaAssets.id, draft.studioMediaAssetId)).get();
  const media = asset
    ? [{ type: "video", asset_id: asset.id, local_path: asset.localPath, filename: asset.filename, mime_type: asset.mimeType }]
    : [];
  const projections = listVideoTargets(backendDb, videoDraftId).map((target) => ({
    id: `video:${videoDraftId}:${target.target}`,
    label: target.target === "youtube_shorts" ? "Preview · YouTube Shorts" : "Preview · Instagram Reels",
    targets: [target.target],
    text: "",
    media,
    metadata: (target.metadataJson ?? {}) as Record<string, unknown>,
    notes: [],
  })) satisfies DeliveryProjection[];
  return { kind: "video" as const, videoDraftId, projections, sourceAvailable: media.length === 1 };
}
