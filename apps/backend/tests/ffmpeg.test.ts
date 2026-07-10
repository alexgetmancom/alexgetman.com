import { describe, expect, it } from "vitest";
import { configureFfmpegConcurrency, ffmpegMaxConcurrency } from "../src/runtime/ffmpeg.js";

describe("ffmpeg guard", () => {
  it("never permits more than two concurrent transcodes", () => {
    configureFfmpegConcurrency(99);
    expect(ffmpegMaxConcurrency()).toBe(2);
    configureFfmpegConcurrency(1);
    expect(ffmpegMaxConcurrency()).toBe(1);
    configureFfmpegConcurrency(2);
  });
});
