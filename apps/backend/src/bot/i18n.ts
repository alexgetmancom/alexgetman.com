import { eq } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { botUiSettings } from "../db/schema.js";
import type { StudioLocale } from "../foundation/locale.js";

export type BotLocale = StudioLocale;

export function botLocale(backendDb: BackendDb, actorId: number): BotLocale {
  return backendDb.db.select({ value: botUiSettings.locale }).from(botUiSettings).where(eq(botUiSettings.actorId, actorId)).get()?.value ===
    "ru"
    ? "ru"
    : "en";
}
