export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, message: string, details?: unknown): void {
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
