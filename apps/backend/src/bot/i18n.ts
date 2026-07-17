import { eq } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { botUiSettings } from "../db/schema.js";
import type { StudioLocale } from "../foundation/locale.js";

export type BotLocale = StudioLocale;

export function botLocale(backendDb: BackendDb, adminId: number): BotLocale {
  return backendDb.db.select({ value: botUiSettings.locale }).from(botUiSettings).where(eq(botUiSettings.adminId, adminId)).get()?.value ===
    "ru"
    ? "ru"
    : "en";
}
