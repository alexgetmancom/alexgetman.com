import { describe, expect, it } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";
import { PUBLICATION_ACTIONS, PUBLICATION_CARD_ACTIONS } from "../src/bot/session-fsm.js";

/** Callback prefixes the dispatcher in `bot.ts` resolves to a handler. A new
 * button whose prefix is missing here fails this test: a rendered callback with
 * no branch reaches the post handler, which answers "invalid post" on a button
 * the user sees as ordinary navigation. Add the handler, then the prefix. */
const HANDLED_PREFIXES = new Set([
  // bot.ts and the post screen
  "menu_home",
  "menu_text",
  "cancel_dialog",
  "queue_home",
  "queue_drafts",
  "queue_page",
  "queue_attention",
  "queue_attention_page",
  "post_retry",
  "post_retry_notice",
  "notifications_home",
  // post card and scheduling
  "preview",
  "platforms",
  "toggle",
  "cycle_mode",
  "sources",
  "edit_ru",
  "edit_en",
  "replace_ru_media",
  "replace_en_media",
  "cancel",
  "cancel_confirm",
  "cancel_state",
  "publish",
  "publish_confirm",
  "schedule",
  "sched_scope",
  "sched_view",
  "sched_pick",
  "sched_manual",
  "sched_manual_confirm",
  "story_publish_all",
  "story_publish_site",
  "story_schedule_all",
  "story_schedule_site",
  "threads_chain",
  // progress card
  "progress",
  "progress_details",
  "progress_cancel",
  // delivery previews
  "delivery_preview_threads",
  "delivery_preview_video",
  // analytics and archive
  "analytics_home",
  "analytics_total",
  "analytics_period",
  "analytics_section",
  "analytics_post",
  "analytics_video",
  "analytics_archive",
  "analytics_post_archive",
  "analytics_post_media",
  "archive_home",
  "archive_noop",
  // operations
  "deploy_pr_ask",
  "deploy_rb_ask",
]);

/** Splits a call's argument list on top-level commas. */
function splitArgs(src: string, start: number): string[] | null {
  let depth = 0;
  let current = "";
  const args: string[] = [];
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const ch = src.charAt(i);
    if (quote) {
      current += ch;
      if (ch === quote && src.charAt(i - 1) !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (ch === ")" && depth === 0) {
        args.push(current);
        return args;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  return null;
}

async function renderedCallbacks(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
  for await (const relativeFile of new Glob("**/*.ts").scan({ cwd: sourceRoot })) {
    const file = path.join(sourceRoot, relativeFile);
    const src = await Bun.file(file).text();
    for (let idx = src.indexOf(".text("); idx !== -1; idx = src.indexOf(".text(", idx + 1)) {
      const args = splitArgs(src, idx + ".text(".length);
      if (!args || args.length < 2) continue;
      const last = args[args.length - 1]?.trim() ?? "";
      if (last.startsWith("publicationCallback(")) {
        const callbackArgs = splitArgs(last, "publicationCallback(".length);
        const kind = callbackArgs?.[0]?.trim().replace(/^['"]|['"]$/g, "");
        const action = callbackArgs?.[1]?.trim().replace(/^['"]|['"]$/g, "");
        if ((kind === "post" || kind === "video") && action && !action.includes("$")) {
          const key = `${kind}:${action}`;
          if (!found.has(key)) found.set(key, file);
        }
        continue;
      }
      if (!/^(`|")/.test(last)) continue;
      // A menu-plugin `.text(label, handler)` never carries callback data, and
      // template holes are ids, not part of the routed prefix.
      const literal = last.slice(1, -1).replace(/\$\{[^}]*\}/g, "");
      const prefix = literal.split(":")[0]?.trim() ?? "";
      if (prefix && !found.has(prefix)) found.set(prefix, file);
    }
  }
  return found;
}

describe("Telegram callback wiring", () => {
  it("routes every callback the bot renders on a button", async () => {
    const rendered = await renderedCallbacks();
    // i18n message keys reach the same argument position on menu-plugin
    // buttons, whose handler is a function rather than callback data.
    const publicationKeys = Object.entries(PUBLICATION_ACTIONS).flatMap(([kind, actions]) => actions.map((action) => `${kind}:${action}`));
    const handled = new Set([...HANDLED_PREFIXES, ...publicationKeys]);
    const unrouted = [...rendered]
      .filter(([prefix]) => !prefix.includes(".") && !handled.has(prefix))
      .map(([prefix, file]) => `${prefix} (${file})`);

    expect(unrouted).toEqual([]);
  });

  it("finds the callbacks it is supposed to be checking", async () => {
    const rendered = await renderedCallbacks();
    expect([...rendered.keys()]).toContain("post:sched_scope");
    expect([...rendered.keys()]).toContain("video:now");
    expect([...rendered.keys()]).toContain("notifications_home");
  });

  it("keeps post routing and freshness vocabulary in one contract", () => {
    expect(PUBLICATION_ACTIONS.post).toEqual(expect.arrayContaining(["threads_chain"]));
    expect(PUBLICATION_CARD_ACTIONS.post).toContain("threads_chain");
    expect(PUBLICATION_ACTIONS.video).toEqual(expect.arrayContaining(["schedule"]));
    expect(PUBLICATION_CARD_ACTIONS.video).toContain("schedule");
  });
});
