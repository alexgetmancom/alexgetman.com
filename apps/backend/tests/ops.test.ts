import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBackendDb } from "../src/db/client.js";
import { metricSchedule } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { capabilitySummary, seedCapabilities } from "../src/operations/capabilities.js";
import {
  applyMetricsBackfill,
  auditOperations,
  backupDatabase,
  buildMetricsBackfillPlan,
  publicationConsistencyReport,
  repairPublicationConsistency,
  withMaintenanceLock,
} from "../src/operations/maintenance.js";
import { pipelineStatusPayload } from "../src/operations/read-model.js";

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
      expect((backendDb.sqlite.prepare("SELECT count(*) AS count FROM platform_capabilities").get() as { count: number }).count).toBe(81);
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
        .prepare("INSERT INTO post_targets(post_key,target,status,updated_at) VALUES ('post:1','threads_ru','published',?)")
        .run(now);
      const plan = buildMetricsBackfillPlan(backendDb, { targets: ["threads_ru"] });
      expect(plan).toHaveLength(1);
      const config = loadConfig({ ADMIN_IDS: "42" });
      expect(withMaintenanceLock(backendDb, () => applyMetricsBackfill(backendDb, config, plan, true))).toBe(1);
      expect(
        backendDb.sqlite.prepare("SELECT check_count,frozen_at FROM metric_schedule WHERE post_key='post:1' AND target='threads_ru'").get(),
      ).toEqual({ check_count: 0, frozen_at: null });
      expect((backendDb.sqlite.prepare("SELECT count(*) AS count FROM maintenance_locks").get() as { count: number }).count).toBe(0);
    } finally {
      backendDb.close();
    }
  });

  it("keeps frozen terminal metric history out of current status and audit errors", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(metricSchedule)
        .values([
          { postKey: "post:active", target: "telegram", lastError: "temporary", updatedAt: now },
          { postKey: "post:frozen", target: "telegram", lastError: "terminal", frozenAt: now, updatedAt: now },
        ])
        .run();
      const status = pipelineStatusPayload(loadConfig({ PIPELINE_DB: ":memory:" }), backendDb);
      expect(status.metrics.schedule?.errors).toBe(1);
      expect(auditOperations(backendDb).metricScheduleErrors).toEqual([{ target: "telegram", count: 1, latest: now }]);
    } finally {
      backendDb.close();
    }
  });

  it("repairs orphaned publication rows and canonical state mismatches", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.sqlite.run("PRAGMA foreign_keys=OFF");
      backendDb.sqlite.query("INSERT INTO metric_schedule(post_key,target,updated_at) VALUES ('post:orphan','telegram',?)").run(now);
      backendDb.sqlite.run("PRAGMA foreign_keys=ON");
      backendDb.sqlite.query("INSERT INTO publications(post_id,status,created_at,updated_at) VALUES (1,'failed',?,?)").run(now, now);
      backendDb.sqlite
        .query(
          "INSERT INTO drafts(id,admin_id,status,text_ru,targets_json,post_id,created_at,updated_at) VALUES (1,1,'failed','text','{}',1,?,?)",
        )
        .run(now, now);
      backendDb.sqlite
        .query(
          "INSERT INTO posts(post_key,post_id,channel,message_id,status,created_at,updated_at) VALUES ('post:1',1,'test',1,'active',?,?)",
        )
        .run(now, now);
      backendDb.sqlite
        .query("INSERT INTO post_targets(post_key,target,status,error,updated_at) VALUES ('post:1','telegram','failed','stale',?)")
        .run(now);
      backendDb.sqlite
        .query(
          "INSERT INTO publish_jobs(post_id,post_key,message_id,target,status,created_at,updated_at) VALUES (1,'post:1',1,'telegram','published',?,?)",
        )
        .run(now, now);
      expect(publicationConsistencyReport(backendDb).targetMismatches).toHaveLength(1);
      expect(repairPublicationConsistency(backendDb)).toMatchObject({
        foreignKeyViolations: 0,
        deletedOrphans: 1,
        repairedTargets: 1,
        repairedPublications: 1,
      });
      expect(backendDb.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(backendDb.sqlite.query("SELECT status,error FROM post_targets WHERE post_key='post:1' AND target='telegram'").get()).toEqual({
        status: "published",
        error: null,
      });
      expect(backendDb.sqlite.query("SELECT status FROM publications WHERE post_id=1").get()).toEqual({ status: "published" });
      expect(backendDb.sqlite.query("SELECT status FROM drafts WHERE id=1").get()).toEqual({ status: "published" });
    } finally {
      backendDb.close();
    }
  });
});
