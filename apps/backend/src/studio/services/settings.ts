import { eq } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { botSettings, botUiSettings } from "../../db/schema.js";
import type { StudioActorId, StudioLocale } from "../contracts.js";

/** Owner settings commands used by Telegram today and any future Studio adapter. */
export function settingsService(backendDb: BackendDb) {
  return {
    youtubeSignature(actorId: StudioActorId): string {
      return backendDb.db.select().from(botSettings).where(eq(botSettings.adminId, actorId)).get()?.youtubeSignature.trim() ?? "";
    },
    beginYoutubeSignatureEdit(actorId: StudioActorId): void {
      const now = new Date().toISOString();
      backendDb.db
        .insert(botSettings)
        .values({ adminId: actorId, youtubeSignature: "", pendingAction: "youtube_signature", updatedAt: now })
        .onConflictDoUpdate({ target: botSettings.adminId, set: { pendingAction: "youtube_signature", updatedAt: now } })
        .run();
    },
    saveYoutubeSignature(actorId: StudioActorId, value: string): boolean {
      const setting = backendDb.db.select().from(botSettings).where(eq(botSettings.adminId, actorId)).get();
      if (setting?.pendingAction !== "youtube_signature") return false;
      backendDb.db
        .update(botSettings)
        .set({ youtubeSignature: value === "-" ? "" : value, pendingAction: null, updatedAt: new Date().toISOString() })
        .where(eq(botSettings.adminId, actorId))
        .run();
      return true;
    },
    clearYoutubeSignature(actorId: StudioActorId): void {
      const now = new Date().toISOString();
      backendDb.db
        .insert(botSettings)
        .values({ adminId: actorId, youtubeSignature: "", pendingAction: null, updatedAt: now })
        .onConflictDoUpdate({ target: botSettings.adminId, set: { youtubeSignature: "", pendingAction: null, updatedAt: now } })
        .run();
    },
    setLocale(actorId: StudioActorId, locale: StudioLocale): void {
      backendDb.db
        .insert(botUiSettings)
        .values({ adminId: actorId, locale, updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({ target: botUiSettings.adminId, set: { locale, updatedAt: new Date().toISOString() } })
        .run();
    },
  };
}
