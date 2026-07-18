import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { autoId, type JsonValue, json, timestamps } from "./_shared.js";

export const postEvents = sqliteTable(
  "post_events",
  {
    id: autoId(),
    postKey: text(),
    eventType: text().notNull().default("ops.event"),
    severity: text().notNull().default("info"),
    target: text(),
    message: text().notNull(),
    detailsJson: text(),
    createdAt: text().notNull(),
    ackedAt: text(),
  },
  (table) => [index("idx_post_events_lookup").on(table.postKey, table.target, table.createdAt)],
);

export const opsActions = sqliteTable("ops_actions", {
  actionId: autoId(),
  actorType: text().notNull(),
  action: text().notNull(),
  messageId: integer(),
  target: text(),
  status: text().notNull(),
  detailsJson: text(),
  createdAt: text().notNull(),
  completedAt: text(),
});

export const workerState = sqliteTable("worker_state", {
  name: text().primaryKey(),
  stateJson: json<Record<string, JsonValue>>().notNull(),
  updatedAt: text().notNull(),
});

export const deploymentSnapshots = sqliteTable("deployment_snapshots", {
  id: autoId(),
  gitSha: text(),
  action: text().notNull(),
  status: text().notNull(),
  backupPath: text(),
  detailsJson: text(),
  createdAt: text().notNull(),
});

export const alertDedup = sqliteTable("alert_dedup", {
  alertKey: text().primaryKey(),
  lastSentAt: text().notNull(),
  suppressedCount: integer().notNull().default(0),
});

export const maintenanceLocks = sqliteTable("maintenance_locks", {
  name: text().primaryKey(),
  owner: text().notNull(),
  expiresAt: text().notNull(),
  createdAt: text().notNull(),
});

export const credentialChecks = sqliteTable("credential_checks", {
  target: text().primaryKey(),
  status: text().notNull(),
  requiredEnvJson: text().notNull(),
  missingEnvJson: text().notNull(),
  expiresAt: text(),
  lastCheckedAt: text().notNull(),
  nextCheckAt: text(),
  lastError: text(),
  detailsJson: text(),
});

export const platformRules = sqliteTable(
  "platform_rules",
  {
    target: text().notNull(),
    formatKey: text().notNull(),
    supportStatus: text().notNull().default("unknown"),
    maxItems: integer(),
    notes: text(),
    updatedAt: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.target, table.formatKey] })],
);

export const platformCapabilities = sqliteTable(
  "platform_capabilities",
  {
    target: text().notNull(),
    formatKey: text().notNull(),
    status: text().notNull().default("unknown"),
    evidenceTestId: text(),
    evidenceMessageId: integer(),
    evidenceUrl: text(),
    notes: text(),
    updatedAt: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.target, table.formatKey] })],
);

export const mediaTestCases = sqliteTable("media_test_cases", {
  testId: text().primaryKey(),
  formatKey: text().notNull(),
  title: text().notNull(),
  inputRecipe: text().notNull(),
  expectedTargetsJson: text().notNull(),
  status: text().notNull().default("pending"),
  lastMessageId: integer(),
  notes: text(),
  ...timestamps(),
});

export const mediaTestResults = sqliteTable(
  "media_test_results",
  {
    testId: text().notNull(),
    target: text().notNull(),
    messageId: integer().notNull(),
    status: text().notNull(),
    externalId: text(),
    url: text(),
    error: text(),
    notes: text(),
    rawJson: json<JsonValue | null>(),
    checkedAt: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.testId, table.target, table.messageId] })],
);
