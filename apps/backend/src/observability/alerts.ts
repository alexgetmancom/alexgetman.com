import crypto from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { alertDedup, publicationEvents } from "../db/schema.js";
import { log } from "../foundation/logger.js";

/** How long one alert subject stays quiet after it has been reported. */
export const ALERT_COOLDOWN_SECONDS = 3600;

export type AlertPort = { sendAlert?: (text: string) => Promise<void> };

/** Delivers unacknowledged durable events through an optional transport adapter. */
export async function deliverPendingAlerts(backendDb: BackendDb, alertsPort: AlertPort): Promise<number> {
  let alerts = 0;
  const events = unsafeDb(backendDb)
    .db.select({
      id: publicationEvents.id,
      eventType: publicationEvents.eventType,
      severity: publicationEvents.severity,
      target: publicationEvents.target,
      message: publicationEvents.message,
    })
    .from(publicationEvents)
    .where(and(inArray(publicationEvents.severity, ["warn", "error"]), isNull(publicationEvents.ackedAt)))
    .orderBy(asc(publicationEvents.createdAt), asc(publicationEvents.id))
    .limit(20)
    .all();
  for (const event of events) {
    const key = crypto
      .createHash("sha256")
      .update(`${event.eventType}\0${event.target ?? ""}\0${event.message}`)
      .digest("hex");
    const now = new Date().toISOString();
    const disposition = unsafeDb(backendDb).db.transaction((tx) => {
      const dedup = tx.select().from(alertDedup).where(eq(alertDedup.alertKey, key)).get();
      const cooling = dedup?.lastSentAt && Date.now() - new Date(dedup.lastSentAt).getTime() < ALERT_COOLDOWN_SECONDS * 1000;
      if (!cooling && !alertsPort.sendAlert) return "unavailable";
      const claimed = tx
        .update(publicationEvents)
        .set({ ackedAt: now })
        .where(and(eq(publicationEvents.id, event.id), isNull(publicationEvents.ackedAt)))
        .returning({ id: publicationEvents.id })
        .get();
      if (!claimed) return "claimed";
      if (cooling) {
        tx.update(alertDedup)
          .set({ suppressedCount: sql`${alertDedup.suppressedCount} + 1` })
          .where(eq(alertDedup.alertKey, key))
          .run();
        return "suppressed";
      }
      tx.insert(alertDedup)
        .values({ alertKey: key, lastSentAt: now, suppressedCount: 0 })
        .onConflictDoUpdate({ target: alertDedup.alertKey, set: { lastSentAt: now, suppressedCount: 0 } })
        .run();
      return "send";
    });
    if (disposition !== "send") continue;
    try {
      await alertsPort.sendAlert?.(`[${event.severity.toUpperCase()}] ${event.target ?? event.eventType}\n${event.message}`.slice(0, 4000));
      alerts += 1;
    } catch (error) {
      // The durable reservation precedes the external call. A transport error
      // may still mean Telegram accepted the message, so retrying could alert
      // the audience twice; keep the attempt settled and continue the batch.
      log("error", "alert delivery failed after durable reservation", { event: event.id, error: String(error) });
    }
  }
  return alerts;
}
