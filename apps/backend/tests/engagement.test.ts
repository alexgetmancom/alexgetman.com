import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { openBackendDb } from "../src/db/client.js";
import { likes } from "../src/db/schema.js";
import { batchLikes, clientIpHash, metricsSummary, recordPageview } from "../src/public/engagement.js";

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

  it("uses SQLite counters for pageviews and ignores untrusted forwarded IPs", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ LIKES_SALT: "salt", TRUSTED_CLIENT_IP_HEADER: "x-real-ip" });
      recordPageview(backendDb, config, "/article/");
      recordPageview(backendDb, config, "/article/");
      expect(backendDb.sqlite.prepare("SELECT count FROM site_pageviews WHERE path=?").get("/article/")).toEqual({ count: 2 });
      expect(metricsSummary(backendDb)).toMatchObject({ total: 2, today: 2, last7: 2 });

      const left = clientIpHash(
        new Request("https://example.test", { headers: { "x-real-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.1" } }),
        config,
      );
      const right = clientIpHash(
        new Request("https://example.test", { headers: { "x-real-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.2" } }),
        config,
      );
      expect(left).toBe(right);
    } finally {
      backendDb.close();
    }
  });
});
