import { and, eq } from "drizzle-orm";
import type { ChannelStore } from "../../application/ports.js";
import { channelConnections, channelCredentials } from "../schema.js";
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

    hasAny() {
      return Boolean(db.select({ id: channelConnections.id }).from(channelConnections).limit(1).get());
    },

    find(platform, locale) {
      return (
        db
          .select()
          .from(channelConnections)
          .where(and(eq(channelConnections.platform, platform), eq(channelConnections.locale, locale), eq(channelConnections.enabled, 1)))
          .get() ?? null
      );
    },

    secrets(channelId) {
      return db
        .select({ name: channelCredentials.name, valueEncrypted: channelCredentials.valueEncrypted })
        .from(channelCredentials)
        .where(eq(channelCredentials.channelId, channelId))
        .all();
    },

    saveSecret(input) {
      db.insert(channelCredentials)
        .values(input)
        .onConflictDoUpdate({
          target: [channelCredentials.channelId, channelCredentials.name],
          set: { valueEncrypted: input.valueEncrypted, updatedAt: input.updatedAt },
        })
        .run();
    },

    deleteSecrets(channelId, name) {
      const where = name
        ? and(eq(channelCredentials.channelId, channelId), eq(channelCredentials.name, name))
        : eq(channelCredentials.channelId, channelId);
      db.delete(channelCredentials).where(where).run();
    },

    secretNames(channelId) {
      return db
        .select({ name: channelCredentials.name })
        .from(channelCredentials)
        .where(eq(channelCredentials.channelId, channelId))
        .all()
        .map((row) => row.name);
    },
  };
}
