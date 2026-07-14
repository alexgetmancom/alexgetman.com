import { describe, expect, it } from "bun:test";
import { allowPublicRequest } from "../src/public/rate-limit.js";

describe("public rate limiter", () => {
  it("limits a key inside its window and resets it afterwards", () => {
    expect(allowPublicRequest("test:rate-limit", 2, 60, 0).allowed).toBe(true);
    expect(allowPublicRequest("test:rate-limit", 2, 60, 1).allowed).toBe(true);
    const blocked = allowPublicRequest("test:rate-limit", 2, 60, 2);
    expect(blocked).toMatchObject({ allowed: false, retryAfter: 60 });
    expect(allowPublicRequest("test:rate-limit", 2, 60, 60_001).allowed).toBe(true);
  });
});
