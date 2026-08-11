import type { Bot } from "grammy";
import { InputFile } from "grammy";
import { claimSync, markSynced } from "../../analytics/snapshots/creator-store.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import { log } from "../../foundation/logger.js";
import { settingsService } from "../../studio/services/settings.js";

type GrokProcess = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
};

export type GrokSpawn = (command: string[], options: { stdout: "pipe"; stderr: "pipe" }) => GrokProcess;

export type NewsDigestRunResult =
  | { status: "sent" }
  | { status: "disabled" | "not_due" | "missing_prompt" | "already_sent" }
  | { status: "failed"; error: string };

const NEWS_DIGEST_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    markdown: { type: "string", minLength: 1, pattern: "^1\\." },
  },
  required: ["markdown"],
  additionalProperties: false,
});
const NEWS_DIGEST_OUTPUT_INSTRUCTIONS =
  'Return exactly one JSON object with a "markdown" string. The markdown value must begin immediately with item 1 as `1.`. Do not output progress updates, search status, reasoning, an introduction, a conclusion, or any text outside that JSON object.';
const NEWS_DIGEST_RETRY_INSTRUCTIONS =
  "Your previous response was rejected because its markdown did not begin immediately with `1.`. This is the final attempt: return exactly one JSON object with a markdown value that starts with `1.` and contains only the requested news items.";

class NewsDigestFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewsDigestFormatError";
  }
}

/** Runs one shared daily Grok report and delivers it as a Markdown document. */
export async function sendDailyNewsDigest(
  config: BackendConfig,
  backendDb: BackendDb,
  bot: Bot | null,
  now = new Date(),
  options: { force?: boolean; spawn?: GrokSpawn } = {},
): Promise<NewsDigestRunResult> {
  if (!bot || config.CONTROLLER_ADMIN_IDS.length === 0) return { status: "disabled" };
  const settings = settingsService(backendDb).newsDigest();
  if (!options.force && !settings.enabled) return { status: "disabled" };
  if (!settings.prompt) return { status: "missing_prompt" };

  const date = zonedDate(config.TIMEZONE, now);
  if (!options.force && date.hour * 60 + date.minute < settings.hour * 60 + settings.minute) return { status: "not_due" };

  const key = `news_digest:${date.day}`;
  const owner = "telegram:news-digest";
  if (!options.force && !claimSync(backendDb, key, 24 * 60 * 60, owner)) return { status: "already_sent" };

  try {
    const markdown = await runGrok(config, settings.prompt, options.spawn ?? (Bun.spawn as unknown as GrokSpawn));
    const filename = `news-digest-${date.day}.md`;
    let delivered = 0;
    for (const actorId of config.CONTROLLER_ADMIN_IDS) {
      const locale = settingsService(backendDb).locale(actorId);
      try {
        await bot.api.sendDocument(actorId, new InputFile(Buffer.from(markdown, "utf8"), filename), {
          caption: t(locale, "settings.news-digest-document-caption"),
        });
        delivered += 1;
      } catch (error) {
        log("warn", "news digest was not delivered", { actorId, error: String(error) });
      }
    }
    if (delivered === 0) throw new Error("Telegram rejected the news digest for every administrator");
    if (!options.force) markSynced(backendDb, key, null, owner);
    return { status: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.force) markSynced(backendDb, key, message.slice(0, 500), owner);
    log("warn", "daily news digest failed", { error: message });
    return { status: "failed", error: message };
  }
}

async function runGrok(config: BackendConfig, prompt: string, spawn: GrokSpawn): Promise<string> {
  let formatError: NewsDigestFormatError | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const attemptPrompt = `${prompt.trim()}\n\n${NEWS_DIGEST_OUTPUT_INSTRUCTIONS}${attempt === 1 ? `\n\n${NEWS_DIGEST_RETRY_INSTRUCTIONS}` : ""}`;
      return await runGrokAttempt(config, attemptPrompt, spawn);
    } catch (error) {
      if (!(error instanceof NewsDigestFormatError) || attempt === 1) throw error;
      formatError = error;
    }
  }
  throw formatError ?? new Error("Grok CLI did not produce a news digest");
}

async function runGrokAttempt(config: BackendConfig, prompt: string, spawn: GrokSpawn): Promise<string> {
  const child = spawn(
    [
      config.GROK_CLI_PATH,
      "--no-leader",
      "--reasoning-effort",
      "low",
      "--output-format",
      "json",
      "--json-schema",
      NEWS_DIGEST_JSON_SCHEMA,
      "--always-approve",
      "--single",
      prompt,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, config.GROK_CLI_TIMEOUT_SECONDS * 1000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error(`Grok CLI timed out after ${config.GROK_CLI_TIMEOUT_SECONDS} seconds`);
    if (exitCode !== 0) throw new Error(`Grok CLI exited with code ${exitCode}: ${stderr.trim().slice(0, 500)}`);
    let response: unknown;
    try {
      response = JSON.parse(stdout);
    } catch {
      throw new NewsDigestFormatError("Grok CLI returned invalid JSON");
    }
    if (!response || typeof response !== "object" || !("text" in response) || typeof response.text !== "string") {
      throw new NewsDigestFormatError("Grok CLI JSON response did not contain text");
    }
    const markdown = extractMarkdown(response.text);
    if (markdown === null) throw new NewsDigestFormatError("Grok CLI did not return structured news markdown");
    if (!markdown.startsWith("1.")) throw new NewsDigestFormatError("Grok news markdown must start with 1.");
    return `${markdown.trimEnd()}\n`;
  } finally {
    clearTimeout(timeout);
  }
}

function extractMarkdown(text: string): string | null {
  const value = text.trim();
  for (let index = value.lastIndexOf("{"); index >= 0; index = value.lastIndexOf("{", index - 1)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value.slice(index));
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && "markdown" in parsed && typeof parsed.markdown === "string") {
      return parsed.markdown;
    }
  }
  return null;
}

function zonedDate(timeZone: string, now: Date): { day: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}
