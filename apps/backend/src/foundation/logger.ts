import { redactExternalSecrets } from "./redact.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minimumLevel: LogLevel = "info";

export function configureLogging(level: LogLevel): void {
  minimumLevel = level;
}

/** An Error has no enumerable own properties, so JSON.stringify renders it as
 * `{}` -- message, name and stack all vanish. Every call site currently spells
 * out String(error) or error.message to work around that; this makes the
 * workaround unnecessary rather than something each new call site has to
 * remember, since forgetting it fails silently and only in the logs. */
function serializeErrors(_key: string, value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  return {
    name: value.name,
    message: value.message,
    ...(value.stack === undefined ? {} : { stack: value.stack }),
    ...(value.cause === undefined ? {} : { cause: value.cause }),
  };
}

export function log(level: LogLevel, message: string, details?: unknown): void {
  if (rank[level] < rank[minimumLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(details === undefined ? {} : { details }),
  };
  // Redaction runs over the serialized line, not over `details` field by field:
  // callers pass arbitrary shapes (error bodies, nested API payloads, plain
  // strings), and a secret can sit at any depth or inside a message. One pass
  // over the finished JSON is total by construction.
  const output = redactExternalSecrets(JSON.stringify(line, serializeErrors));
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}
