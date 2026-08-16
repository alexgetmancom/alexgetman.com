import { StudioError } from "../foundation/errors.js";
import type { InstagramMetadata, VideoMetadata, VideoTarget, YouTubeMetadata } from "./video-types.js";

/**
 * What each platform accepts, checked where the text is typed.
 *
 * These were never checked at all: whatever the operator wrote was sent, and
 * the platform's refusal arrived at publication time, hours later, as a code in
 * a worker log. A tag list two characters over the limit cost a Short its slot
 * and left the target unable to be fixed, because a half-published draft froze
 * its own metadata.
 *
 * The budgets sit under the platform's real ceiling on purpose. A limit met
 * exactly is a limit crossed by the next emoji: platforms count some characters
 * as two, and a description gains a signature line before it is sent.
 */
export const VIDEO_METADATA_LIMITS = {
  /** YouTube: 100. */
  youtubeTitle: 95,
  /** YouTube: 5000, and this Studio appends a game link and a signature. */
  youtubeDescription: 4_800,
  /** YouTube: 500, counted the way `youtubeTagsLength` explains. */
  youtubeTags: 470,
  /** YouTube accepts more, but a tag this long is a sentence, not a keyword. */
  youtubeTag: 60,
  /** Instagram: 2200. */
  instagramCaption: 2_100,
} as const;

/**
 * How YouTube measures a tag list: the serialized list, not the sum of its tags.
 *
 * Tags are joined by commas, a tag containing a space is wrapped in quotes, and
 * every one of those characters counts against the 500. Two live refusals and
 * six accepted publications put the boundary exactly there: 472 went through,
 * 521 did not, and counting only the tags would have placed the cap at some
 * number that is not 500 — which is the number YouTube documents.
 */
export function youtubeTagsLength(tags: readonly string[]): number {
  return tags.reduce((total, tag) => total + tag.length + (tag.includes(" ") ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

/** Rejects text a platform would refuse, naming what to cut and by how much. */
export function assertVideoMetadata(target: VideoTarget, metadata: VideoMetadata): void {
  if (target === "instagram_reels") {
    assertInstagramCaption((metadata as InstagramMetadata).caption ?? "");
    return;
  }
  const youtube = metadata as YouTubeMetadata;
  assertYouTubeTitle(youtube.title ?? "");
  assertYouTubeDescription(youtube.description ?? "");
  assertYouTubeTags(youtube.tags ?? []);
}

export function assertInstagramCaption(caption: string): void {
  if (caption.length > VIDEO_METADATA_LIMITS.instagramCaption)
    throw new StudioError("err.video-caption-too-long", {
      used: caption.length,
      limit: VIDEO_METADATA_LIMITS.instagramCaption,
      over: caption.length - VIDEO_METADATA_LIMITS.instagramCaption,
    });
}

export function assertYouTubeTitle(title: string): void {
  if (title.length > VIDEO_METADATA_LIMITS.youtubeTitle)
    throw new StudioError("err.video-title-too-long", {
      used: title.length,
      limit: VIDEO_METADATA_LIMITS.youtubeTitle,
      over: title.length - VIDEO_METADATA_LIMITS.youtubeTitle,
    });
  // YouTube refuses these outright, and a title is where a stray one lands.
  if (title.includes("<") || title.includes(">")) throw new StudioError("err.video-title-brackets");
}

export function assertYouTubeDescription(description: string): void {
  if (description.length > VIDEO_METADATA_LIMITS.youtubeDescription)
    throw new StudioError("err.video-description-too-long", {
      used: description.length,
      limit: VIDEO_METADATA_LIMITS.youtubeDescription,
      over: description.length - VIDEO_METADATA_LIMITS.youtubeDescription,
    });
}

export function assertYouTubeTags(tags: readonly string[]): void {
  // No cap on how many: YouTube has none, and the budget below is the real
  // constraint. A count of our own would refuse lists the platform accepts.
  const long = tags.find((tag) => tag.length > VIDEO_METADATA_LIMITS.youtubeTag);
  if (long) throw new StudioError("err.video-tag-too-long", { tag: long, limit: VIDEO_METADATA_LIMITS.youtubeTag });
  const used = youtubeTagsLength(tags);
  if (used > VIDEO_METADATA_LIMITS.youtubeTags)
    throw new StudioError("err.video-tags-too-long", {
      used,
      limit: VIDEO_METADATA_LIMITS.youtubeTags,
      over: used - VIDEO_METADATA_LIMITS.youtubeTags,
    });
}
