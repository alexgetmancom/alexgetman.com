import { expect, test } from "bun:test";
import { mediaPolicyForTarget } from "../src/publishing/media-policy.js";

const images = Array.from({ length: 11 }, () => ({ type: "image" }));

test("media policy states delivery limits and story projection without mutating content", () => {
  expect(mediaPolicyForTarget("telegram", images)).toMatchObject({ inputCount: 11, deliveredCount: 10, mode: "limited" });
  expect(mediaPolicyForTarget("bluesky", images)).toMatchObject({ deliveredCount: 4, mode: "limited" });
  expect(mediaPolicyForTarget("telegram_stories", images)).toMatchObject({ deliveredCount: 1, mode: "story-first" });
  expect(mediaPolicyForTarget("github_en", images)).toMatchObject({ deliveredCount: 11, mode: "all" });
  expect(mediaPolicyForTarget("facebook", [{ type: "image" }, { type: "video" }])).toMatchObject({ deliveredCount: 1, mode: "first" });
});
