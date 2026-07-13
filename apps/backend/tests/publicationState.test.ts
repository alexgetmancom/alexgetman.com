import { describe, expect, it } from "bun:test";
import { isVideoTargetEditable, isVideoTargetSchedulable, publicationStatus, videoDraftStatus } from "../src/publishing/state.js";

describe("publication state transitions", () => {
  it("keeps published video targets immutable while allowing scheduled targets to move", () => {
    expect(isVideoTargetEditable("editing")).toBe(true);
    expect(isVideoTargetEditable("scheduled")).toBe(false);
    expect(isVideoTargetSchedulable("scheduled")).toBe(true);
    expect(isVideoTargetSchedulable("published")).toBe(false);
  });

  it("derives final draft and publication states consistently", () => {
    expect(videoDraftStatus(["published", "published"])).toBe("published");
    expect(videoDraftStatus(["published", "failed"])).toBe("partial");
    expect(videoDraftStatus(["published", "scheduled"])).toBe("scheduled");
    expect(publicationStatus(["published", "failed"])).toBe("failed");
    expect(publicationStatus(["published", "queued"])).toBeNull();
  });
});
