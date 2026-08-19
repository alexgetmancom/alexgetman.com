export {};

/**
 * Theme switching for the site.
 *
 * The initial value is applied by an inline script in layouts/Layout.astro,
 * before first paint. This module only handles what happens afterwards: the
 * click, persistence, and following the OS setting while the mode is system.
 *
 * Three modes, cycled by the button: system -> light -> dark -> system. The
 * resolved theme lives in data-theme on <html>; the mode the user picked lives
 * in data-theme-mode beside it, because "dark" chosen explicitly and "dark"
 * resolved from the OS have to look the same to CSS and different to the
 * button. localStorage holds the mode, and holds nothing while it is system.
 */

type Theme = "dark" | "light";
type Mode = Theme | "system";

const STORAGE_KEY = "theme";
const CYCLE: Mode[] = ["system", "light", "dark"];

const systemTheme = (): Theme => (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

const currentMode = (): Mode => {
  const value = document.documentElement.getAttribute("data-theme-mode");
  return value === "light" || value === "dark" ? value : "system";
};

const apply = (mode: Mode): void => {
  const theme = mode === "system" ? systemTheme() : mode;
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-theme-mode", mode);

  // The browser UI colour is a meta tag, not a CSS variable, so it cannot pick
  // the token up on its own — read the resolved value and copy it across.
  const meta = document.querySelector('meta[name="theme-color"]');
  const chrome = getComputedStyle(document.documentElement).getPropertyValue("--browser-chrome").trim();
  if (meta && chrome) meta.setAttribute("content", chrome);
};

apply(currentMode());

for (const button of document.querySelectorAll("[data-theme-toggle]")) {
  button.addEventListener("click", () => {
    const next = CYCLE[(CYCLE.indexOf(currentMode()) + 1) % CYCLE.length]!;
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode and blocked storage: the switch still works for this page.
    }
    apply(next);
  });
}

matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (currentMode() === "system") apply("system");
});
