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
  const output = JSON.stringify(line);
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}
