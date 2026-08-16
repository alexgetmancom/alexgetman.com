import { describe, expect, it } from "bun:test";
import { assertVideoMetadata, VIDEO_METADATA_LIMITS, youtubeTagsLength } from "../src/publishing/video-metadata-limits.js";
import { advanceVideoMetadata } from "../src/studio/video-fsm.js";

/** The list that cost a Short its slot: 36 tags, 444 characters of text, and 29
 * of them with spaces — which YouTube counts as quoted, putting it at 502. */
const REFUSED_TAGS = [
  "игры",
  "gaming",
  "видеоигры",
  "игры на пк",
  "pc gaming",
  "steam",
  "игры steam",
  "новые игры",
  "новые игры 2026",
  "кооперативные игры",
  "кооп игры",
  "игры с друзьями",
  "игры для компании",
  "мультиплеер",
  "multiplayer games",
  "co op games",
  "online co op",
  "инди игры",
  "смешные игры",
  "хоррор игры",
  "кооп хоррор",
  "survival horror",
  "party games",
  "игры на четверых",
  "игры на пятерых",
  "игры на шестерых",
  "Backrooms",
  "игры Backrooms",
  "CoopRooms",
  "CoopRooms gameplay",
  "Escape School",
  "Escape School gameplay",
  "Pizza Oof",
  "Pizza Oof gameplay",
  "кооп с друзьями",
  "игры для пати",
];

describe("what a platform will accept", () => {
  it("counts a tag list the way YouTube does", () => {
    expect(REFUSED_TAGS.reduce((total, tag) => total + tag.length, 0)).toBe(444);
    // The quotes around the 29 tags with spaces, plus the commas between all 36,
    // are the difference between "comfortably inside 500" and refused.
    expect(youtubeTagsLength(REFUSED_TAGS)).toBe(537);
    expect(youtubeTagsLength(["one", "two words"])).toBe(3 + 1 + ("two words".length + 2));
  });

  it("matches what the platform actually accepted and refused", () => {
    // Six published Shorts and two refusals bound the rule from both sides. The
    // measurement has to keep them on the right side of 500, or the check is a
    // guess that costs a slot.
    const accepted = [472, 239, 265, 218, 342, 294];
    const refused = [537, 521];
    for (const measured of accepted) expect(measured).toBeLessThanOrEqual(500);
    for (const measured of refused) expect(measured).toBeGreaterThan(500);
    // And our own budget stays under the smallest refusal with room to spare.
    expect(VIDEO_METADATA_LIMITS.youtubeTags).toBeLessThan(Math.min(...refused));
  });

  it("refuses the list at the step where it is typed", () => {
    expect(() => advanceVideoMetadata("youtube_tags", REFUSED_TAGS.join(", "), {})).toThrow("err.video-tags-too-long");
    // Cutting the six most disposable of them is enough, and the same input
    // then passes untouched.
    const kept = REFUSED_TAGS.filter(
      (tag) => !["игры на пятерых", "игры на шестерых", "игры для пати", "кооп с друзьями", "online co op", "co op games"].includes(tag),
    );
    expect(advanceVideoMetadata("youtube_tags", kept.join(", "), {})).toMatchObject({ youtube_tags: kept });
  });

  it("names the field and the overflow rather than failing at publication", () => {
    expect(() => advanceVideoMetadata("youtube_title", "x".repeat(VIDEO_METADATA_LIMITS.youtubeTitle + 1), {})).toThrow(
      "err.video-title-too-long",
    );
    expect(() => advanceVideoMetadata("youtube_title", "a <b> c", {})).toThrow("err.video-title-brackets");
    expect(() => advanceVideoMetadata("instagram_caption", "x".repeat(VIDEO_METADATA_LIMITS.instagramCaption + 1), {})).toThrow(
      "err.video-caption-too-long",
    );
    expect(() => advanceVideoMetadata("youtube_description", "x".repeat(VIDEO_METADATA_LIMITS.youtubeDescription + 1), {})).toThrow(
      "err.video-description-too-long",
    );
  });

  it("holds every interface to the same limits, not just the wizard", () => {
    // MCP, the bot and the CLI all write metadata through one function, which is
    // where this is enforced; each of them checking for itself is how one of
    // them ends up not checking.
    expect(() => assertVideoMetadata("youtube_shorts", { title: "Clip", description: "", tags: REFUSED_TAGS })).toThrow(
      "err.video-tags-too-long",
    );
    expect(() => assertVideoMetadata("instagram_reels", { caption: "x".repeat(10) })).not.toThrow();
  });
});
