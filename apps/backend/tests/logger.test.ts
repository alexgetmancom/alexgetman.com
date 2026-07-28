import { afterEach, describe, expect, it } from "bun:test";
import { configureLogging, log } from "../src/foundation/logger.js";
import { redactExternalSecrets } from "../src/foundation/redact.js";

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

/** Stubs all three sinks: log() routes error to console.error and warn to
 * console.warn, so capturing only console.log silently misses those lines. */
function captureLog(run: () => void): string[] {
  const lines: string[] = [];
  const push = (value: string) => lines.push(value);
  console.log = push;
  console.warn = push;
  console.error = push;
  run();
  return lines;
}

function captureOneLine(run: () => void): string {
  const lines = captureLog(run);
  expect(lines).toHaveLength(1);
  return lines[0] ?? "";
}

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  configureLogging("info");
});

describe("redactExternalSecrets", () => {
  it("masks query credentials, bot tokens and bearer headers", () => {
    expect(redactExternalSecrets("https://api.test/x?access_token=abc123")).toBe("https://api.test/x?access_token=[REDACTED]");
    expect(redactExternalSecrets("GET /bot123456789:AA-Ee_ff/sendMessage")).toBe("GET /bot[REDACTED]/sendMessage");
    expect(redactExternalSecrets("Authorization: Bearer ey.J0.eXA")).toBe("Authorization: Bearer [REDACTED]");
  });

  it("leaves text without credentials untouched", () => {
    expect(redactExternalSecrets("publish job finalization failed")).toBe("publish job finalization failed");
  });
});

describe("log", () => {
  it("redacts secrets in the message", () => {
    const line = captureOneLine(() => log("error", "call to https://api.test/x?api_key=s3cret failed"));
    expect(line).toContain("api_key=[REDACTED]");
    expect(line).not.toContain("s3cret");
  });

  // The regression this guards: redaction used to live only on the HTTP layer,
  // so anything reaching the logger through `details` bypassed it entirely.
  it("redacts secrets nested anywhere in details", () => {
    const line = captureOneLine(() =>
      log("error", "publish job finalization failed", {
        jobId: 7,
        response: { body: "denied for Bearer ey.J0.eXA", url: "https://api.test/bot987654321:ZZ-Yy_xx/send" },
      }),
    );
    expect(line).toContain("Bearer [REDACTED]");
    expect(line).toContain("/bot[REDACTED]/send");
    expect(line).not.toContain("ey.J0.eXA");
    expect(line).not.toContain("987654321");
  });

  it("keeps the line valid JSON and preserves non-secret fields", () => {
    const line = captureOneLine(() => log("warn", "site build slow", { jobId: 12, seconds: 41 }));
    const parsed = JSON.parse(line) as { level: string; message: string; details: { jobId: number; seconds: number } };
    expect(parsed.level).toBe("warn");
    expect(parsed.message).toBe("site build slow");
    expect(parsed.details).toEqual({ jobId: 12, seconds: 41 });
  });

  it("still honours the configured minimum level", () => {
    configureLogging("warn");
    expect(captureLog(() => log("info", "ignored"))).toHaveLength(0);
  });
});
