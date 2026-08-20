import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { extractMessage } from "../src/bot/message.js";
import { mediaSizeAdvice, RECOMMENDED_MEDIA_BYTES } from "../src/content/media-size-advice.js";

/** extractMessage only ever reads ctx.message, so a literal is a truer stand-in
 * than a full grammy Context: it keeps each case's shape visible. */
function ctx(message: unknown): Context {
  return { message } as Context;
}

const photo = [
  { file_id: "small", file_unique_id: "s", width: 90, height: 60 },
  { file_id: "large", file_unique_id: "l", width: 1280, height: 853 },
];

describe("extractMessage", () => {
  it("takes text and entities from a plain text message", () => {
    const entities = [{ type: "bold", offset: 0, length: 6 }];
    expect(extractMessage(ctx({ text: "Claude ships a browser", entities }))).toEqual({
      text: "Claude ships a browser",
      media: [],
      entities,
    });
  });

  it("falls back to the caption and caption_entities on a media message", () => {
    const captionEntities = [{ type: "italic", offset: 0, length: 5 }];
    expect(extractMessage(ctx({ caption: "Photo caption", caption_entities: captionEntities, photo }))).toMatchObject({
      text: "Photo caption",
      entities: captionEntities,
    });
  });

  it("keeps only the largest photo size", () => {
    expect(extractMessage(ctx({ caption: "", photo })).media).toEqual([{ type: "photo", file_id: "large", width: 1280, height: 853 }]);
  });

  it("carries the video duration through", () => {
    const video = { file_id: "vid", file_unique_id: "v", width: 1080, height: 1920, duration: 42 };
    expect(extractMessage(ctx({ caption: "clip", video })).media).toEqual([
      { type: "video", file_id: "vid", width: 1080, height: 1920, duration: 42 },
    ]);
  });

  it("returns a photo and a video together when the message carries both", () => {
    const media = extractMessage(
      ctx({ caption: "both", photo, video: { file_id: "vid", file_unique_id: "v", width: 1080, height: 1920, duration: 7 } }),
    ).media;
    expect(media.map((entry) => entry.type)).toEqual(["photo", "video"]);
  });

  it("treats a missing text, caption, entities and photo array as empty rather than throwing", () => {
    expect(extractMessage(ctx({}))).toEqual({ text: "", media: [], entities: [] });
    expect(extractMessage(ctx({ text: undefined, entities: undefined }))).toEqual({ text: "", media: [], entities: [] });
    expect(extractMessage(ctx({ photo: [] })).media).toEqual([]);
  });

  it("returns an empty draft when the update carries no message at all", () => {
    expect(extractMessage(ctx(undefined))).toEqual({ text: "", media: [], entities: [] });
  });
});

describe("mediaSizeAdvice", () => {
  it("says nothing about a file within the recommendation", () => {
    expect(mediaSizeAdvice([{ type: "video", file_size: RECOMMENDED_MEDIA_BYTES }])).toBeNull();
  });

  it("reports the largest oversized item in megabytes", () => {
    expect(
      mediaSizeAdvice([
        { type: "video", file_size: 60_000_000 },
        { type: "video", file_size: 1_000_000_000 },
      ]),
    ).toEqual({
      megabytes: 1000,
      recommendedMegabytes: 50,
    });
  });

  it("ignores items Telegram sent no size for", () => {
    expect(mediaSizeAdvice([{ type: "photo" }, { type: "video", file_size: "huge" }])).toBeNull();
  });

  it("reads the size extractMessage captures from a video message", () => {
    const video = { file_id: "vid", file_unique_id: "v", width: 1080, height: 1920, duration: 42, file_size: 1_000_000_000 };
    expect(mediaSizeAdvice(extractMessage(ctx({ caption: "clip", video })).media)).toEqual({
      megabytes: 1000,
      recommendedMegabytes: 50,
    });
  });
});
