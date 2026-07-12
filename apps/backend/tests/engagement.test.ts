import { describe, expect, it } from "bun:test";
import { openBackendDb } from "../src/db/client.js";
import { likes } from "../src/db/schema.js";
import { batchLikes } from "../src/services/engagement.js";

describe("engagement likes", () => {
  it("returns batched counts and caller liked state", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      backendDb.db
        .insert(likes)
        .values([
          { postId: "1", ipHash: "a" },
          { postId: "1", ipHash: "b" },
          { postId: "2", ipHash: "b" },
        ])
        .run();
      expect(batchLikes(backendDb, ["1", "2", "3"], "a")).toEqual({
        "1": { likes: 2, user_liked: true },
        "2": { likes: 1, user_liked: false },
        "3": { likes: 0, user_liked: false },
      });
    } finally {
      backendDb.close();
    }
  });
});
