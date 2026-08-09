import { describe, expect, it } from "bun:test";
import { clientIpHash } from "../src/engagement/identity.js";
import { metricsSummary, recordPageview } from "../src/engagement/pageviews.js";
import { loadConfig } from "../src/foundation/config.js";
import { openBackendDb } from "./helpers/open-db.js";

describe("site engagement", () => {
  it("uses SQLite counters for pageviews and ignores untrusted forwarded IPs", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ CLIENT_IP_HASH_SALT: "salt", TRUSTED_CLIENT_IP_HEADER: "x-real-ip" });
      recordPageview(backendDb, "/article/");
      recordPageview(backendDb, "/article/");
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
