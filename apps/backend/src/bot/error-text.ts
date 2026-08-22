import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { describeError, t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";

/** How a failed publication action reads to the operator.
 *
 * One error needs more than its catalogue line: a date the parser refused is
 * only answerable if the reply says which zone the bot was reading it in. Both
 * message handlers and the callback router spelled that out separately, and a
 * fourth caller would have spelled it out again. */
export function describePublicationError(locale: StudioLocale, error: unknown, config: Pick<BackendConfig, "TIMEZONE_LABEL">): string {
  if (error instanceof StudioError && error.code === "common.schedule-parse-error")
    return t(locale, "common.schedule-parse-error", { timezone: config.TIMEZONE_LABEL });
  return describeError(locale, error);
}
