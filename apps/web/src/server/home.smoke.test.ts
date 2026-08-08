import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURE_JPEG, seedSiteFixture } from "./site-fixture.js";

/**
 * A single end-to-end smoke test: it boots the real Astro dev server against
 * a throwaway seeded database and fetches the SSR HTML, the same way a
 * crawler or a first-time visitor would. Unlike the rest of the suite it does
 * not check individual functions — it exists to catch "the home page (and
 * therefore the Svelte story player) silently stopped rendering", which unit
 * tests for the player's internals cannot see. Keep this to a couple of
 * scenarios; anything more belongs in a real UI testing tool instead.
 *
 * Two non-obvious things this had to work around:
 * - `astro dev` must run under `bun --bun`, not its Node shebang directly —
 *   the backend opens `bun:sqlite`, which Node's ESM loader cannot resolve.
 * - `astro dev` keeps a single background daemon per project directory and
 *   ignores a new `--port` if one is already running (e.g. left over from a
 *   crashed previous run, or a `bun run dev` a human has open). We call
 *   `astro dev stop` before and after to avoid hanging on someone else's
 *   server — don't run this smoke test while you're also using `bun run dev`.
 */

const projectRoot = path.resolve(import.meta.dir, "../../../..");
const astroBin = path.join(projectRoot, "node_modules/.bin/astro");
const port = 4400 + Math.floor(Math.random() * 400);
const host = "127.0.0.1";
const baseUrl = `http://${host}:${port}`;

/** Final viewer projection produced by the media worker and exposed by the
 * live site read-model. Keeping this end-to-end catches a regression where
 * the worker makes the vertical composite but the website links the source. */
const FIXTURE_IMAGE_PATH = "media/posts/1-en-0-vertical.jpg";

let dbDir: string;
let publicDir: string;
let server: ReturnType<typeof Bun.spawn> | undefined;

async function stopAnyDaemon(): Promise<void> {
  const stop = Bun.spawn([astroBin, "dev", "stop"], { cwd: projectRoot, stdout: "ignore", stderr: "ignore" });
  await stop.exited;
}

async function waitUntilReady(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Dev server did not become ready on ${baseUrl}: ${String(lastError)}`);
}

/** Real `<h1>` tags only — Svelte's dev-mode inline `<style>` blocks keep
 * source comments verbatim, and this file's own comments mention `<h1>`. */
function countRealTags(html: string, tag: string): number {
  const withoutStyles = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  return (withoutStyles.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
}

beforeAll(async () => {
  await stopAnyDaemon();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-home-smoke-"));
  const dbPath = path.join(dbDir, "pipeline.db");
  publicDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-home-smoke-media-"));
  const seeded = seedSiteFixture({ dbPath, publicDir });
  // The fixture derives this name from the production naming helper; assert the
  // literal the tests below fetch, so a convention change fails here loudly.
  expect(seeded.imagePaths).toEqual([FIXTURE_IMAGE_PATH]);
  server = Bun.spawn(["bun", "--bun", astroBin, "dev", "--port", String(port), "--host", host], {
    cwd: projectRoot,
    env: { ...process.env, PIPELINE_DB: dbPath, SITE_PUBLIC_DIR: publicDir, ENABLE_WORKERS: "0" },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitUntilReady(30_000);
}, 40_000);

afterAll(async () => {
  server?.kill();
  await stopAnyDaemon();
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(publicDir, { recursive: true, force: true });
});

describe("home page SSR smoke test", () => {
  it("renders the story player with a single SEO h1 and the seeded post", async () => {
    const html = await (await fetch(baseUrl)).text();

    expect(countRealTags(html, "h1")).toBe(1);
    expect(html).toContain("Smoke test post body");
    expect(html).toContain("data-story-player");
  });

  it("renders the Russian home page with its own locale content", async () => {
    const html = await (await fetch(`${baseUrl}/ru/`)).text();

    expect(countRealTags(html, "h1")).toBe(1);
    expect(html).toContain("дымового теста");
  });

  it("renders the individual post page with NewsArticle structured data", async () => {
    const html = await (await fetch(`${baseUrl}/1/smoke-test-post/`)).text();

    expect(countRealTags(html, "h1")).toBe(1);
    expect(html).toContain('"@type":"NewsArticle"');
    expect(html).toContain('"isBasedOn":["https://example.com/official-announcement"]');
    expect(html).toContain('"url":"https://alexgetman.com/entities/company/example-ai/"');
  });

  it("serves the seeded post's image through the real media route", async () => {
    const html = await (await fetch(baseUrl)).text();
    expect(html).toContain(`/${FIXTURE_IMAGE_PATH}`);

    const response = await fetch(`${baseUrl}/${FIXTURE_IMAGE_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("image/");
    expect((await response.arrayBuffer()).byteLength).toBe(FIXTURE_JPEG.byteLength);
  });
});
