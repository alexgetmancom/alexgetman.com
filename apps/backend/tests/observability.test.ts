import { describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { registerChannel } from "../src/channels/registry.js";
import { alertDedup, channelConnections, credentialChecks, postEvents, publishJobs, siteJobs, workerState } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { expectedWorkerNames } from "../src/foundation/runtime/worker-state.js";
import { renderDashboard } from "../src/interfaces/web/dashboard.js";
import { runObservabilityCycle } from "../src/observability/cycle.js";
import { healthReport } from "../src/observability/health.js";
import { recordMemoryPressure } from "../src/observability/runtime-health.js";
import { commandCenterPayload } from "../src/operations/command-center.js";
import { registerTestChannels, TEXT_TEST_CHANNELS, VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";

function testHarness() {
  const backendDb = openBackendDb(":memory:");
  registerTestChannels(backendDb, [...TEXT_TEST_CHANNELS, ...VIDEO_TEST_CHANNELS]);
  const sendMessage = mock(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
  const alertsPort = { sendAlert: async (_text: string) => void (await sendMessage()) };
  const config = loadConfig({ CONTROLLER_ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "token", ALERT_COOLDOWN_SECONDS: "3600" });
  return { backendDb, sendMessage, alertsPort, config };
}

function recordFailure(backendDb: ReturnType<typeof openBackendDb>, message: string): void {
  backendDb.db
    .insert(postEvents)
    .values({ eventType: "publish.failed", severity: "error", target: "x", message, createdAt: new Date().toISOString() })
    .run();
}

function countEvents(backendDb: ReturnType<typeof openBackendDb>, eventType: string): number {
  return backendDb.db.select().from(postEvents).where(eq(postEvents.eventType, eventType)).all().length;
}

describe("observability", () => {
  it("checks credentials and alerts the owner on a failure", async () => {
    const { backendDb, sendMessage, alertsPort, config } = testHarness();
    try {
      recordFailure(backendDb, "API unavailable");
      expect(await runObservabilityCycle(config, backendDb, alertsPort)).toMatchObject({ alerts: 1 });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(backendDb.db.select().from(credentialChecks).all().length).toBeGreaterThan(8);
    } finally {
      backendDb.close();
    }
  });

  it("deduplicates a repeated error within the cooldown and counts the suppression", async () => {
    const { backendDb, sendMessage, alertsPort, config } = testHarness();
    try {
      recordFailure(backendDb, "API unavailable");
      await runObservabilityCycle(config, backendDb, alertsPort);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      recordFailure(backendDb, "API unavailable");
      expect(await runObservabilityCycle(config, backendDb, alertsPort)).toMatchObject({ alerts: 0 });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(backendDb.db.select({ suppressedCount: alertDedup.suppressedCount }).from(alertDedup).get()?.suppressedCount).toBe(1);
    } finally {
      backendDb.close();
    }
  });

  it("reports a stale queue lock exactly once", async () => {
    const { backendDb, config } = testHarness();
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(publishJobs)
        .values({
          postId: 1,
          postKey: "post:stale",
          messageId: 1,
          target: "threads_ru",
          status: "publishing",
          lockedAt: "2000-01-01T00:00:00.000Z",
          payloadJson: {},
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "queue.stale")).toBe(1);
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "queue.stale")).toBe(1);
    } finally {
      backendDb.close();
    }
  });

  it("reports a failed site build", async () => {
    const { backendDb, config } = testHarness();
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(siteJobs)
        .values({
          postId: 7,
          messageId: 7,
          reason: "site_ru",
          status: "failed",
          lastError: "Astro build failed",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "site.build.failed")).toBe(1);
    } finally {
      backendDb.close();
    }
  });

  it("does not re-alert on a terminal social job that already reported at its transition", async () => {
    const { backendDb, config } = testHarness();
    try {
      // A terminal social job emits publish.job.failed at its state transition.
      // Observability must not generate a fresh target.failed alert every hour.
      const now = new Date().toISOString();
      backendDb.db
        .insert(publishJobs)
        .values({
          postId: 8,
          postKey: "post:terminal",
          messageId: 8,
          target: "telegram_stories",
          status: "failed",
          lastError: "MEDIA_FILE_INVALID",
          payloadJson: {},
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await runObservabilityCycle(config, backendDb);
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "target.failed")).toBe(0);
    } finally {
      backendDb.close();
    }
  });
});

function seedPreviousBoot(backendDb: ReturnType<typeof openBackendDb>, restartsAt: string[]): void {
  const now = new Date().toISOString();
  backendDb.db
    .insert(workerState)
    .values({
      name: "runtime",
      stateJson: { bootId: "previous-process", bootedAt: new Date(Date.now() - 60_000).toISOString(), restartsAt },
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: workerState.name, set: { updatedAt: now } })
    .run();
}

describe("runtime health", () => {
  it("adopts the runtime identity silently on a fresh database", async () => {
    const { backendDb, config } = testHarness();
    try {
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(0);
      expect(backendDb.db.select().from(workerState).where(eq(workerState.name, "runtime")).get()).toBeTruthy();
    } finally {
      backendDb.close();
    }
  });

  it("records a single restart as info so a deploy does not page the owner", async () => {
    const { backendDb, sendMessage, alertsPort, config } = testHarness();
    try {
      seedPreviousBoot(backendDb, []);
      await runObservabilityCycle(config, backendDb, alertsPort);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(1);
      // Alert delivery only picks up warn/error, so an ordinary restart must not
      // reach the transport.
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      backendDb.close();
    }
  });

  it("reports the same process only once across repeated cycles", async () => {
    const { backendDb, config } = testHarness();
    try {
      seedPreviousBoot(backendDb, []);
      await runObservabilityCycle(config, backendDb);
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(1);
    } finally {
      backendDb.close();
    }
  });

  it("escalates to an alert when restarts cluster inside the window", async () => {
    const { backendDb, sendMessage, alertsPort, config } = testHarness();
    try {
      const recent = [new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 60_000).toISOString()];
      seedPreviousBoot(backendDb, recent);
      await runObservabilityCycle(config, backendDb, alertsPort);
      expect(countEvents(backendDb, "runtime.restart.looping")).toBe(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      backendDb.close();
    }
  });

  it("ignores restarts that fell out of the window", async () => {
    const { backendDb, config } = testHarness();
    try {
      const stale = [new Date(Date.now() - 5 * 3600_000).toISOString(), new Date(Date.now() - 4 * 3600_000).toISOString()];
      seedPreviousBoot(backendDb, stale);
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "runtime.restart.looping")).toBe(0);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(1);
    } finally {
      backendDb.close();
    }
  });

  it("warns once when rss crosses the container limit threshold", () => {
    const { backendDb, config } = testHarness();
    try {
      const tightLimit = Math.round(process.memoryUsage().rss / 0.99);
      expect(recordMemoryPressure(config, backendDb, tightLimit)).toBe(true);
      expect(recordMemoryPressure(config, backendDb, tightLimit)).toBe(false);
      expect(countEvents(backendDb, "runtime.memory.pressure")).toBe(1);
    } finally {
      backendDb.close();
    }
  });

  it("stays quiet below the threshold and when no cgroup limit applies", () => {
    const { backendDb, config } = testHarness();
    try {
      expect(recordMemoryPressure(config, backendDb, process.memoryUsage().rss * 100)).toBe(false);
      expect(recordMemoryPressure(config, backendDb, null)).toBe(false);
      expect(countEvents(backendDb, "runtime.memory.pressure")).toBe(0);
    } finally {
      backendDb.close();
    }
  });
});

/** Every capability requirement satisfied, so `ok` reflects credentials and
 * workers alone rather than being pinned false by a missing integration. */
const READY_ENV = {
  CONTROLLER_ADMIN_IDS: "42",
  CONTROLLER_BOT_TOKEN: "token",
  YOUTUBE_RU_CLIENT_ID: "id",
  YOUTUBE_RU_CLIENT_SECRET: "secret",
  YOUTUBE_RU_REFRESH_TOKEN: "refresh",
  THREADS_RU_ACCESS_TOKEN: "token",
  THREADS_EN_ACCESS_TOKEN: "token",
  X_CONSUMER_KEY: "key",
  X_CONSUMER_SECRET: "secret",
  X_ACCESS_TOKEN: "token",
  X_ACCESS_TOKEN_SECRET: "secret",
  TELEGRAM_CHANNEL_STORIES_API_ID: "1",
  TELEGRAM_CHANNEL_STORIES_API_HASH: "hash",
  TELEGRAM_CHANNEL_STORIES_SESSION: "session",
  INSTAGRAM_RU_USER_ID: "ru",
  INSTAGRAM_RU_ACCESS_TOKEN: "token",
  INSTAGRAM_EN_USER_ID: "en",
  INSTAGRAM_EN_ACCESS_TOKEN: "token",
};

const checkedAt = "2026-07-27T10:00:00.000Z";

function insertCredential(backendDb: ReturnType<typeof openBackendDb>, target: string, status: string): void {
  backendDb.db
    .insert(credentialChecks)
    .values({ target, status, requiredEnvJson: "[]", missingEnvJson: "[]", lastCheckedAt: checkedAt })
    .run();
}

function insertWorker(backendDb: ReturnType<typeof openBackendDb>, name: string, state: Record<string, boolean | string>): void {
  backendDb.db.insert(workerState).values({ name, stateJson: state, updatedAt: checkedAt }).run();
}

function insertExpectedWorkers(
  backendDb: ReturnType<typeof openBackendDb>,
  config: ReturnType<typeof loadConfig>,
  overrides: Record<string, Record<string, boolean | string>> = {},
): void {
  for (const name of expectedWorkerNames(config)) insertWorker(backendDb, name, overrides[name] ?? { phase: "idle" });
}

function insertAlertEvent(backendDb: ReturnType<typeof openBackendDb>, severity: string, ackedAt: string | null): void {
  backendDb.db
    .insert(postEvents)
    .values({ eventType: "publish.failed", severity, target: "x", message: "m", ackedAt, createdAt: checkedAt })
    .run();
}

function setHealthChannels(backendDb: ReturnType<typeof openBackendDb>, targets: Array<"telegram" | "threads_ru" | "x">): void {
  backendDb.db.delete(channelConnections).run();
  for (const target of targets) {
    const locale = target === "x" ? "en" : "ru";
    registerChannel(backendDb, {
      platform: target === "threads_ru" ? "threads" : target,
      locale,
      provider: "native",
      targetId: target,
      source: "test",
    });
  }
}

describe("healthReport", () => {
  it("scopes health and dashboard credentials to registered channels", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig(READY_ENV);
      setHealthChannels(backendDb, ["telegram"]);
      insertCredential(backendDb, "telegram", "ready");
      insertCredential(backendDb, "threads_ru", "missing");
      insertExpectedWorkers(backendDb, config);

      const report = healthReport(config, backendDb);
      expect(report.ok).toBe(true);
      expect(report.credentials.map((credential) => credential.target)).toEqual(["telegram"]);
      expect(report.capabilities.map((capability) => capability.target)).toEqual(["controller_bot", "telegram"]);

      const dashboard = commandCenterPayload(config, backendDb);
      expect(dashboard.credentials.map((credential) => credential.target)).toEqual(["telegram"]);
      const html = renderDashboard(config, backendDb, 0);
      expect(html).not.toContain('class="nav-more__toggle nav-more__toggle--attention"');
      expect(html).not.toContain('<i class="nav-dot"></i>');
    } finally {
      backendDb.close();
    }
  });

  it("reports ok with an ISO timestamp when credentials, workers and capabilities are all ready", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      setHealthChannels(backendDb, ["x"]);
      insertCredential(backendDb, "x", "ready");
      const config = loadConfig(READY_ENV);
      insertExpectedWorkers(backendDb, config);
      const report = healthReport(config, backendDb);

      expect(report.ok).toBe(true);
      expect(report.pendingAlerts).toBe(0);
      expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
      expect(report.capabilities.every((capability) => capability.status === "ready")).toBe(true);
    } finally {
      backendDb.close();
    }
  });

  it("goes not-ok when any credential check is not ready", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      setHealthChannels(backendDb, ["x", "threads_ru"]);
      insertCredential(backendDb, "x", "ready");
      insertCredential(backendDb, "threads_ru", "expired");
      insertWorker(backendDb, "publisher", { ok: true });

      expect(healthReport(loadConfig(READY_ENV), backendDb).ok).toBe(false);
    } finally {
      backendDb.close();
    }
  });

  it("goes not-ok when a worker reports ok:false, and stays ok when it reports no verdict", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      setHealthChannels(backendDb, ["x"]);
      insertCredential(backendDb, "x", "ready");
      const config = loadConfig(READY_ENV);
      insertExpectedWorkers(backendDb, config, { queue: { ok: false, lastError: "stalled" } });
      expect(healthReport(config, backendDb).ok).toBe(false);
    } finally {
      backendDb.close();
    }

    const clean = openBackendDb(":memory:");
    try {
      setHealthChannels(clean, ["x"]);
      insertCredential(clean, "x", "ready");
      const config = loadConfig(READY_ENV);
      insertExpectedWorkers(clean, config);
      expect(healthReport(config, clean).ok).toBe(true);
    } finally {
      clean.close();
    }
  });

  it("goes not-ok when a lifecycle heartbeat is stale", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      setHealthChannels(backendDb, ["x"]);
      insertCredential(backendDb, "x", "ready");
      backendDb.db
        .insert(workerState)
        .values({
          name: "queue",
          stateJson: { ok: true, phase: "running", heartbeat_interval_ms: 60_000, last_heartbeat_at: "2000-01-01T00:00:00.000Z" },
          updatedAt: "2000-01-01T00:00:00.000Z",
        })
        .run();
      const report = healthReport(loadConfig(READY_ENV), backendDb);
      expect(report.ok).toBe(false);
      expect(report.workers.find((worker) => worker.name === "queue")).toMatchObject({ stale: true });
    } finally {
      backendDb.close();
    }
  });

  it("goes not-ok and names the missing env when a capability is unconfigured", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      setHealthChannels(backendDb, ["x"]);
      insertCredential(backendDb, "x", "ready");
      insertWorker(backendDb, "publisher", { ok: true });
      const { CONTROLLER_ADMIN_IDS, CONTROLLER_BOT_TOKEN } = READY_ENV;
      const report = healthReport(loadConfig({ CONTROLLER_ADMIN_IDS, CONTROLLER_BOT_TOKEN }), backendDb);

      expect(report.ok).toBe(false);
      expect(report.capabilities.find((capability) => capability.target === "x")).toMatchObject({
        status: "missing",
        missing: ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"],
      });
    } finally {
      backendDb.close();
    }
  });

  it("counts only unacknowledged warn and error events as pending alerts", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      insertAlertEvent(backendDb, "error", null);
      insertAlertEvent(backendDb, "warn", null);
      insertAlertEvent(backendDb, "error", checkedAt);
      insertAlertEvent(backendDb, "info", null);

      expect(healthReport(loadConfig(READY_ENV), backendDb).pendingAlerts).toBe(2);
    } finally {
      backendDb.close();
    }
  });

  it("reports every expected worker missing in an empty database", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      backendDb.db.delete(channelConnections).run();
      const report = healthReport(loadConfig(READY_ENV), backendDb);
      expect(report).toMatchObject({ ok: false, pendingAlerts: 0, credentials: [], workers: [] });
      expect(report.missingWorkers).toEqual(expectedWorkerNames(loadConfig(READY_ENV)));
    } finally {
      backendDb.close();
    }
  });
});
