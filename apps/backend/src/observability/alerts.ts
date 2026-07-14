import crypto from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { alertDedup, postEvents } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";

export type AlertPort = { sendAlert?: (text: string) => Promise<void> };

/** Delivers unacknowledged durable events through an optional transport adapter. */
export async function deliverPendingAlerts(config: BackendConfig, backendDb: BackendDb, alertsPort: AlertPort): Promise<number> {
  let alerts = 0;
  const events = backendDb.db
    .select({
      id: postEvents.id,
      eventType: postEvents.eventType,
      severity: postEvents.severity,
      target: postEvents.target,
      message: postEvents.message,
    })
    .from(postEvents)
    .where(and(inArray(postEvents.severity, ["warn", "error"]), isNull(postEvents.ackedAt)))
    .orderBy(asc(postEvents.createdAt), asc(postEvents.id))
    .limit(20)
    .all();
  for (const event of events) {
    const key = crypto
      .createHash("sha256")
      .update(`${event.eventType}\0${event.target ?? ""}\0${event.message}`)
      .digest("hex");
    const dedup = backendDb.db.select().from(alertDedup).where(eq(alertDedup.alertKey, key)).get();
    const cooling = dedup?.lastSentAt && Date.now() - new Date(dedup.lastSentAt).getTime() < config.ALERT_COOLDOWN_SECONDS * 1000;
    if (cooling) {
      backendDb.db
        .update(alertDedup)
        .set({ suppressedCount: (dedup.suppressedCount ?? 0) + 1 })
        .where(eq(alertDedup.alertKey, key))
        .run();
      backendDb.db.update(postEvents).set({ ackedAt: new Date().toISOString() }).where(eq(postEvents.id, event.id)).run();
      continue;
    }
    if (!alertsPort.sendAlert) continue;
    await alertsPort.sendAlert(`[${event.severity.toUpperCase()}] ${event.target ?? event.eventType}\n${event.message}`.slice(0, 4000));
    alerts += 1;
    const now = new Date().toISOString();
    backendDb.db
      .insert(alertDedup)
      .values({ alertKey: key, lastSentAt: now, suppressedCount: 0 })
      .onConflictDoUpdate({ target: alertDedup.alertKey, set: { lastSentAt: now, suppressedCount: 0 } })
      .run();
    backendDb.db.update(postEvents).set({ ackedAt: now }).where(eq(postEvents.id, event.id)).run();
  }
  return alerts;
}
