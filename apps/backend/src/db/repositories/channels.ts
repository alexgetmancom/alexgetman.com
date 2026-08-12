import { and, desc, eq } from "drizzle-orm";
import type { ChannelStore } from "../../application/ports.js";
import { channelConnections } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite adapter for channel routing and encrypted credential metadata. */
export function createChannelStore(db: BackendDatabase): ChannelStore {
  return {
    list(enabledOnly) {
      const query = db.select().from(channelConnections);
      return (enabledOnly ? query.where(eq(channelConnections.enabled, 1)) : query).all();
    },

    get(id) {
      return db.select().from(channelConnections).where(eq(channelConnections.id, id)).get() ?? null;
    },

    upsert(input, now) {
      db.insert(channelConnections)
        .values({ ...input, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: channelConnections.id,
          set: {
            platform: input.platform,
            locale: input.locale,
            provider: input.provider,
            providerAccountId: input.providerAccountId,
            targetId: input.targetId,
            label: input.label,
            enabled: input.enabled,
            source: input.source,
            updatedAt: now,
          },
        })
        .run();
    },

    disable(id, now) {
      db.update(channelConnections).set({ enabled: 0, updatedAt: now }).where(eq(channelConnections.id, id)).run();
    },

    /** The schema allows several enabled accounts for one platform and locale,
     * so which one a video goes to has to be a rule rather than whatever SQLite
     * returned first: the most recently connected account wins. */
    find(platform, locale) {
      return (
        db
          .select()
          .from(channelConnections)
          .where(and(eq(channelConnections.platform, platform), eq(channelConnections.locale, locale), eq(channelConnections.enabled, 1)))
          .orderBy(desc(channelConnections.updatedAt), desc(channelConnections.id))
          .get() ?? null
      );
    },
  };
}
