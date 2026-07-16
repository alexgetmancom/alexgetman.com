import { describe, expect, it } from "bun:test";
import { configureFfmpegConcurrency, ffmpegMaxConcurrency, formatFfmpegFailure } from "../src/foundation/runtime/ffmpeg.js";

describe("ffmpeg guard", () => {
  it("never permits more than two concurrent transcodes", () => {
    configureFfmpegConcurrency(99);
    expect(ffmpegMaxConcurrency()).toBe(2);
    configureFfmpegConcurrency(1);
    expect(ffmpegMaxConcurrency()).toBe(1);
    configureFfmpegConcurrency(2);
  });

  it("keeps OOM and ffmpeg diagnostics actionable and bounded", () => {
    expect(formatFfmpegFailure(137, "frame= 100 fps=20\rKilled")).toBe(
      "media_processing_failed: ffmpeg exit 137: process was killed (likely out of memory)",
    );
    const failure = formatFfmpegFailure(1, "frame= 1 fps=1\rInvalid data found when processing input");
    expect(failure).toContain("Invalid data found when processing input");
    expect(failure).not.toContain("frame=");
  });
});
