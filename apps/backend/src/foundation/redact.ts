/* Secret redaction, kept in its own module rather than in http.ts.
 *
 * It started as an HTTP-response concern, but the structured logger needs the
 * same pass over every `details` payload it serializes, and a logger that
 * imports the fetch machinery to reach one string helper couples the cheapest
 * module in the tree to the heaviest. */

/** Redacts credentials that travel inside free-form text: error bodies, URLs,
 * exception messages. Applied to everything the logger serializes, so it must
 * stay total and never throw on odd input. */
export function redactExternalSecrets(value: string): string {
  return value
    .replace(/(access_token|api[_-]?key|password|token)=([^\s&"']+)/gi, "$1=[REDACTED]")
    .replace(/\/bot\d{6,}:[A-Za-z0-9_-]+/g, "/bot[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}
