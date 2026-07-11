import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBackendDb } from "../src/db/client.js";
import { capabilitySummary, seedCapabilities } from "../src/ops/capabilities.js";
import { applyMetricsBackfill, backupDatabase, buildMetricsBackfillPlan, withMaintenanceLock } from "../src/ops/maintenance.js";

describe("TypeScript operations tooling", () => {
  it("creates a consistent SQLite backup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alexgetman-backup-"));
    const dbPath = join(directory, "pipeline.db");
    const backendDb = openBackendDb(dbPath);
    try {
      backendDb.sqlite.prepare("INSERT INTO worker_state(name,state_json,updated_at) VALUES ('test','{}',?)").run(new Date().toISOString());
      const backup = await backupDatabase(backendDb, dbPath);
      expect(existsSync(backup)).toBe(true);
      expect(backendDb.sqlite.prepare("SELECT backup_path FROM deployment_snapshots ORDER BY id DESC LIMIT 1").get()).toEqual({
        backup_path: backup,
      });
    } finally {
      backendDb.close();
    }
  });

  it("seeds all media capability cases", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedCapabilities(backendDb);
      expect(capabilitySummary(backendDb)).toHaveLength(9);
      expect((backendDb.sqlite.prepare("SELECT count(*) AS count FROM platform_capabilities").get() as { count: number }).count).toBe(153);
    } finally {
      backendDb.close();
    }
  });

  it("plans and applies a metrics backfill under a maintenance lock", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.sqlite
        .prepare(
          "INSERT INTO posts(post_key,post_id,channel,message_id,date_utc,status,created_at,updated_at) VALUES ('post:1',1,'test',1,?,'active',?,?)",
        )
        .run(now, now, now);
      backendDb.sqlite
        .prepare("INSERT INTO post_targets(post_key,target,status,updated_at) VALUES ('post:1','devto','published',?)")
        .run(now);
      const plan = buildMetricsBackfillPlan(backendDb, { targets: ["devto"] });
      expect(plan).toHaveLength(1);
      expect(withMaintenanceLock(backendDb, () => applyMetricsBackfill(backendDb, plan, true))).toBe(1);
      expect(
        backendDb.sqlite.prepare("SELECT check_count,frozen_at FROM metric_schedule WHERE post_key='post:1' AND target='devto'").get(),
      ).toEqual({ check_count: 0, frozen_at: null });
      expect((backendDb.sqlite.prepare("SELECT count(*) AS count FROM maintenance_locks").get() as { count: number }).count).toBe(0);
    } finally {
      backendDb.close();
    }
  });
});
