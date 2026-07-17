import type { BackendConfig } from "../../foundation/config.js";
import { formatZonedDateTime } from "../../foundation/time.js";

/** Telegram presentation formatting; publishing itself works with dates only. */
export function formatMsk(value: string | Date | null, config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">): string {
  return formatZonedDateTime(value, config.TIMEZONE, config.TIMEZONE_LABEL);
}
