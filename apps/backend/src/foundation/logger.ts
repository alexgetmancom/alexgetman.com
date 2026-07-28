import { redactExternalSecrets } from "./redact.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minimumLevel: LogLevel = "info";

export function configureLogging(level: LogLevel): void {
  minimumLevel = level;
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
  const output = redactExternalSecrets(JSON.stringify(line));
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}
