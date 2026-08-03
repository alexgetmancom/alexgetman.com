import type { BackendDb } from "../db/client.js";
import type { StudioLocale } from "../foundation/locale.js";
import { settingsService } from "../studio/services/settings.js";

export type BotLocale = StudioLocale;

export function botLocale(backendDb: BackendDb, actorId: number): BotLocale {
  return settingsService(backendDb).locale(actorId);
}
