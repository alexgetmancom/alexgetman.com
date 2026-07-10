import { afterEach, describe, expect, it } from "vitest";
import { gitRevision } from "../src/runtime/git.js";

describe("gitRevision", () => {
  const original = process.env.GIT_REVISION;

  afterEach(() => {
    if (original == null) delete process.env.GIT_REVISION;
    else process.env.GIT_REVISION = original;
  });

  it("uses the revision injected into a runtime image", () => {
    process.env.GIT_REVISION = "63c3e60";
    expect(gitRevision("/missing-worktree")).toBe("63c3e60");
  });
});
