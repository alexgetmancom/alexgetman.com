import { describe, expect, it } from "bun:test";
import { mayHaveReachedAudience } from "../src/publishing/job-policy.js";

/** Which side of the provider call a lost worker died on. The list of safe
 * phases is closed: a phase this code does not recognise is treated as one that
 * may already have published, because a second post is worse than an unclear
 * status. */
describe("publish phase safety", () => {
  it("lets a job before the provider call go back to the queue", () => {
    expect(mayHaveReachedAudience(null)).toBe(false);
    expect(mayHaveReachedAudience("validate")).toBe(false);
    expect(mayHaveReachedAudience("prepare")).toBe(false);
  });

  it("holds everything from the provider call onwards", () => {
    expect(mayHaveReachedAudience("provider.publish")).toBe(true);
    // Verification only runs once the platform has accepted the post.
    expect(mayHaveReachedAudience("provider.verify")).toBe(true);
    // A phase added later, or one that could not be read at all.
    expect(mayHaveReachedAudience("provider.something-new")).toBe(true);
    expect(mayHaveReachedAudience(undefined)).toBe(true);
  });
});
