/** A domain error whose user-facing text lives in an interface catalog, not here.
 *
 * Studio services stay language-agnostic: they throw a stable `code`, and each
 * interface (Telegram today) decides how to render it. The code doubles as the
 * fallback message so logs and non-localizing callers still read sensibly. */
export class StudioError extends Error {
  readonly code: string;
  readonly params: Record<string, string | number> | undefined;

  constructor(code: string, params?: Record<string, string | number>) {
    super(code);
    this.code = code;
    this.params = params;
    this.name = "StudioError";
  }
}
