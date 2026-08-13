import { describe, expect, it } from "bun:test";
import { pruneOperationalHistory } from "../src/operations/maintenance.js";
import { openBackendDb } from "./helpers/open-db.js";

describe("operational retention", () => {
  it("removes old derived history but preserves unresolved alerts", () => {
    const backendDb = openBackendDb(":memory:");
    const now = new Date("2026-08-03T00:00:00.000Z");
    const old = new Date("2025-01-01T00:00:00.000Z").toISOString();
    try {
      backendDb.sqlite
        .prepare(
          "INSERT INTO post_events(post_key,severity,message,created_at,acked_at) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)",
        )
        .run(
          "post:old",
          "info",
          "old info",
          old,
          null,
          "post:warn",
          "warn",
          "old warning",
          old,
          null,
          "post:error",
          "error",
          "old error",
          old,
          old,
        );
      backendDb.sqlite
        .prepare("INSERT INTO post_events(event_type,severity,message,created_at) VALUES ('analytics.milestone.reached','info',?,?)")
        .run("🎉 X EN: 500 подписчиков!", old);
      backendDb.sqlite.prepare("INSERT INTO ops_actions(actor_type,action,status,created_at) VALUES ('cli','old','ok',?)").run(old);
      backendDb.sqlite.prepare("INSERT INTO site_pageviews(day,path,count,updated_at) VALUES ('2024-01-01','/old',1,?)").run(old);
      backendDb.sqlite
        .prepare(
          "INSERT INTO runtime_usage(feature_key,bucket_day,calls,successes,failures,total_duration_ms,first_seen_at,last_seen_at) VALUES ('test','2024-01-01',1,1,0,1,?,?)",
        )
        .run(old, old);

      const result = pruneOperationalHistory(backendDb, now);

      expect(result).toEqual({ postEvents: 2, opsActions: 1, sitePageviews: 1, runtimeUsage: 1, total: 5 });
      expect(backendDb.sqlite.prepare("SELECT message FROM post_events ORDER BY id").all()).toEqual([
        { message: "old warning" },
        { message: "🎉 X EN: 500 подписчиков!" },
      ]);
    } finally {
      backendDb.close();
    }
  });
});
