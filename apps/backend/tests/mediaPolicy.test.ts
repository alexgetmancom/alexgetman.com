import { expect, test } from "bun:test";
import { guessContentType, mediaExtension } from "../src/delivery/social/payload.js";
import { mediaPolicyForTarget, selectMediaForTarget } from "../src/publishing/media-policy.js";

const images = Array.from({ length: 11 }, () => ({ type: "image" }));

test("media policy states delivery limits and story projection without mutating content", () => {
  expect(mediaPolicyForTarget("telegram", images)).toMatchObject({ inputCount: 11, deliveredCount: 10, mode: "limited" });
  expect(mediaPolicyForTarget("telegram_stories", images)).toMatchObject({ deliveredCount: 1, mode: "story-first" });
});

test("media policy selects the same bounded payload that delivery will send", () => {
  expect(selectMediaForTarget("telegram", images)).toHaveLength(10);
  expect(selectMediaForTarget("telegram_stories", images)).toHaveLength(1);
  expect(selectMediaForTarget("instagram_stories_ru", images)).toHaveLength(1);
});

test("social payload media helpers stay browser-safe without changing extension handling", () => {
  expect(mediaExtension({ type: "IMAGE", localPath: "/tmp/archive.cover.webp" })).toBe(".webp");
  expect(mediaExtension({ type: "VIDEO", localPath: String.raw`C:\media\clip.mov` })).toBe(".mov");
  expect(mediaExtension({ type: "VIDEO", localPath: "/tmp/.hidden" })).toBe(".mp4");
  expect(guessContentType("/tmp/IMAGE.PNG")).toBe("image/png");
  expect(guessContentType("/tmp/photo.avif")).toBe("image/avif");
  expect(guessContentType("/tmp/clip.mov")).toBe("video/quicktime");
  expect(guessContentType("/tmp/no-extension")).toBe("application/octet-stream");
});
