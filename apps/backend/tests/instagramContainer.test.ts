import { describe, expect, it } from "bun:test";
import { InstagramContainerInvalidError, isExpiredInstagramContainer } from "../src/delivery/social/instagram-container.js";
import { ExternalHttpError } from "../src/foundation/http.js";

describe("isExpiredInstagramContainer", () => {
  it("recognises every shape Meta reports a dead creation_id in", () => {
    for (const message of [
      "(#2207027) Media ID is not available",
      "Invalid media id",
      "The container expired",
      "invalid creation_id supplied",
    ])
      expect(isExpiredInstagramContainer(new Error(message))).toBe(true);
  });

  it("does not mistake an unrelated failure for an expired container", () => {
    expect(isExpiredInstagramContainer(new Error("rate limit exceeded"))).toBe(false);
    expect(isExpiredInstagramContainer(null)).toBe(false);
  });

  it("passes through the marker class regardless of its message", () => {
    expect(isExpiredInstagramContainer(new InstagramContainerInvalidError("anything"))).toBe(true);
  });

  it("restricts the match to the given status so a 500 stays retryable", () => {
    const body = "(#2207027) Media ID is not available";
    expect(isExpiredInstagramContainer(new ExternalHttpError("failed", 400, body), 400)).toBe(true);
    // Same prose, transient status: retrying the container is the right call.
    expect(isExpiredInstagramContainer(new ExternalHttpError("failed", 500, body), 400)).toBe(false);
    expect(isExpiredInstagramContainer(new Error(body), 400)).toBe(false);
  });
});
