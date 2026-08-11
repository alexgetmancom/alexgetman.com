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
    markdown: { type: "string", minLength: 1 },
  },
  required: ["markdown"],
  additionalProperties: false,
});
const NEWS_DIGEST_OUTPUT_INSTRUCTIONS =
  "Put the finished digest in the `markdown` field as a numbered Markdown list starting at `1.`, with no introduction or closing remarks around it.";

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
      `${prompt.trim()}\n\n${NEWS_DIGEST_OUTPUT_INSTRUCTIONS}`,
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
      throw new Error("Grok CLI returned invalid JSON");
    }
    if (!response || typeof response !== "object") throw new Error("Grok CLI returned invalid JSON");
    const markdown = readMarkdown(response);
    if (markdown === null) throw new Error("Grok CLI did not return news markdown");
    if (markdown.length === 0) throw new Error("Grok returned an empty news digest");
    return `${markdown}\n`;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Grok fills `structuredOutput` only when the whole reply is one JSON object. While it searches it
 * streams progress updates as further schema-shaped objects concatenated into `text`, which leaves
 * `structuredOutput` null — the digest is then the last complete object in `text`.
 */
function readMarkdown(response: object): string | null {
  const structured = "structuredOutput" in response ? response.structuredOutput : null;
  if (structured && typeof structured === "object" && "markdown" in structured && typeof structured.markdown === "string") {
    return structured.markdown.trim();
  }
  if (!("text" in response) || typeof response.text !== "string") return null;
  const value = response.text.trim();
  // Walk candidate object starts backwards. `lastIndexOf` clamps a negative start to 0, so stop at 0
  // explicitly rather than searching the same position forever.
  for (let index = value.lastIndexOf("{"); index >= 0; index = index === 0 ? -1 : value.lastIndexOf("{", index - 1)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value.slice(index));
    } catch {
      continue;
    }
    // Progress updates are schema-shaped too, so only a value that opens the numbered list is the digest.
    if (parsed && typeof parsed === "object" && "markdown" in parsed && typeof parsed.markdown === "string") {
      const markdown = parsed.markdown.trim();
      if (markdown.startsWith("1.")) return markdown;
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
