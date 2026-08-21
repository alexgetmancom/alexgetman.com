import type { Bot } from "grammy";
import { InputFile } from "grammy";
import { claimSync, markSynced } from "../../analytics/snapshots/creator-store.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import { log } from "../../foundation/logger.js";
import { zonedDateTimeParts } from "../../foundation/time.js";
import { primaryStudioActorId } from "../../studio/access.js";
import { settingsService } from "../../studio/services/settings.js";

/** The Grok CLI is a subprocess; past this it is not coming back. */
const GROK_CLI_TIMEOUT_SECONDS = 900;

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
  "Put the finished digest in the `markdown` field as a numbered Markdown list of 10 items, with one X source URL per item and no introduction or closing remarks around it.";
const MIN_NEWS_DIGEST_CHARACTERS = 2_582;
const MIN_NEWS_DIGEST_ITEMS = 10;
const MIN_NEWS_DIGEST_SOURCE_LINKS = 10;
const NEWS_DIGEST_EFFORTS = ["medium", "xhigh"] as const;

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

  // The hour on the settings screen is the hour the operator set, in the zone
  // they set: reading the deployment default here fired the digest in a
  // different zone than the one the screen showed.
  const owner = primaryStudioActorId(config);
  const timeConfig = settingsService(backendDb).timeConfig(owner ?? 0, config);
  const date = zonedDateTimeParts(now, timeConfig.TIMEZONE);
  if (!options.force && date.hour * 60 + date.minute < settings.hour * 60 + settings.minute) return { status: "not_due" };

  const key = `news_digest:${date.day}`;
  const claimOwner = "telegram:news-digest";
  if (
    !options.force &&
    !claimSync(backendDb, key, {
      intervalSeconds: 24 * 60 * 60,
      leaseSeconds: NEWS_DIGEST_EFFORTS.length * GROK_CLI_TIMEOUT_SECONDS + 60,
      owner: claimOwner,
    })
  )
    return { status: "already_sent" };

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
    if (!options.force) markSynced(backendDb, key, null, claimOwner);
    return { status: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.force) markSynced(backendDb, key, message.slice(0, 500), claimOwner);
    log("warn", "daily news digest failed", { error: message });
    return { status: "failed", error: message };
  }
}

async function runGrok(config: BackendConfig, prompt: string, spawn: GrokSpawn): Promise<string> {
  let lastResult = { characters: 0, items: 0, sourceLinks: 0 };
  for (const [attempt, effort] of NEWS_DIGEST_EFFORTS.entries()) {
    const retryInstructions =
      attempt === 0
        ? ""
        : `\n\nYour previous result was incomplete: ${lastResult.characters} characters, ${lastResult.items} numbered items and ${lastResult.sourceLinks} X source links. Start over and return the finished report.`;
    const attemptPrompt = `${prompt.trim()}\n\n${NEWS_DIGEST_OUTPUT_INSTRUCTIONS}${retryInstructions}`;
    const markdown = await runGrokAttempt(config, attemptPrompt, effort, spawn);
    lastResult = digestShape(markdown);
    if (
      lastResult.characters >= MIN_NEWS_DIGEST_CHARACTERS &&
      lastResult.items >= MIN_NEWS_DIGEST_ITEMS &&
      lastResult.sourceLinks >= MIN_NEWS_DIGEST_SOURCE_LINKS
    )
      return `${markdown}\n`;
  }
  throw new Error(
    `Grok news digest is incomplete: ${lastResult.characters} characters, ${lastResult.items} numbered items and ${lastResult.sourceLinks} X source links; minimum ${MIN_NEWS_DIGEST_CHARACTERS}, ${MIN_NEWS_DIGEST_ITEMS} and ${MIN_NEWS_DIGEST_SOURCE_LINKS}`,
  );
}

async function runGrokAttempt(
  config: BackendConfig,
  prompt: string,
  effort: (typeof NEWS_DIGEST_EFFORTS)[number],
  spawn: GrokSpawn,
): Promise<string> {
  const child = spawn(
    [
      config.GROK_CLI_PATH,
      "--no-leader",
      "--reasoning-effort",
      effort,
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
  }, GROK_CLI_TIMEOUT_SECONDS * 1000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error(`Grok CLI timed out after ${GROK_CLI_TIMEOUT_SECONDS} seconds`);
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
    return markdown;
  } finally {
    clearTimeout(timeout);
  }
}

function digestShape(markdown: string): { characters: number; items: number; sourceLinks: number } {
  const itemNumbers = [...markdown.matchAll(/^(\d+)\.\s+/gm)].map((match) => Number(match[1]));
  let items = 0;
  while (itemNumbers[items] === items + 1) items += 1;
  return {
    characters: [...markdown].length,
    items,
    sourceLinks: [...markdown.matchAll(/https:\/\/x\.com\/[^\s)]+/g)].length,
  };
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
