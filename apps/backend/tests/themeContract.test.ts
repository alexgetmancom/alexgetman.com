import { describe, expect, test } from "bun:test";
import { DASHBOARD_THEME_CSS, SHARED_THEME_TOKENS } from "../src/interfaces/web/dashboard/theme.js";

/**
 * The site and the dashboard are two skins over one token vocabulary. Nothing
 * in the type system connects a CSS custom property on the site to the same
 * name in the dashboard, so a rename on one side would leave the other with
 * `var(--gone)` — which CSS resolves to nothing and renders as unstyled text
 * rather than as an error. This test is the joint.
 *
 * It deliberately checks names only, never values: the two surfaces are
 * supposed to look different.
 */

const SITE_TOKENS_PATH = new URL("../../web/src/shared/styles/tokens.css", import.meta.url);

/** Returns the declaration block introduced by `selector`, braces excluded. */
function blockFor(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  if (open === -1 || close === -1) throw new Error(`unterminated block: ${selector}`);
  return css.slice(open + 1, close);
}

const declaredNames = (block: string): Set<string> =>
  new Set([...block.matchAll(/^\s*--([a-z0-9-]+)\s*:/gm)].map((match) => match[1] as string));

const siteCss = await Bun.file(SITE_TOKENS_PATH).text();

const palettes = {
  "site / dark": declaredNames(blockFor(siteCss, ':root,\nhtml[data-theme="dark"]')),
  "site / light": declaredNames(blockFor(siteCss, 'html[data-theme="light"] {')),
  "dashboard / dark": declaredNames(blockFor(DASHBOARD_THEME_CSS, ':root,\nhtml[data-theme="dark"]')),
  "dashboard / light": declaredNames(blockFor(DASHBOARD_THEME_CSS, 'html[data-theme="light"] {')),
};

describe("theme token contract", () => {
  for (const [name, declared] of Object.entries(palettes)) {
    test(`${name} declares every shared token`, () => {
      const missing = SHARED_THEME_TOKENS.filter((token) => !declared.has(token));
      expect(missing).toEqual([]);
    });
  }
});
