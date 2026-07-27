export {};

/**
 * Theme switching for the site.
 *
 * The initial value is applied by an inline script in layouts/Layout.astro,
 * before first paint. This module only handles what happens afterwards: the
 * click, persistence, and following the OS setting while the user has not made
 * an explicit choice.
 *
 * Persistence rule: localStorage holds a value only after an explicit click.
 * As long as it is empty the page tracks prefers-color-scheme live, so a user
 * who never touched the button sees their system setting change take effect.
 */

type Theme = "dark" | "light";

const STORAGE_KEY = "theme";

const readStored = (): Theme | null => {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    // Private mode and blocked storage: the switch still works for this page.
    return null;
  }
};

const currentTheme = (): Theme => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");

const apply = (theme: Theme): void => {
  document.documentElement.setAttribute("data-theme", theme);

  // The browser UI colour is a meta tag, not a CSS variable, so it cannot pick
  // the token up on its own — read the resolved value and copy it across.
  const meta = document.querySelector('meta[name="theme-color"]');
  const chrome = getComputedStyle(document.documentElement).getPropertyValue("--browser-chrome").trim();
  if (meta && chrome) meta.setAttribute("content", chrome);

  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
  }
};

apply(currentTheme());

for (const button of document.querySelectorAll("[data-theme-toggle]")) {
  button.addEventListener("click", () => {
    const next: Theme = currentTheme() === "light" ? "dark" : "light";
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    apply(next);
  });
}

matchMedia("(prefers-color-scheme: light)").addEventListener("change", (event) => {
  if (readStored()) return;
  apply(event.matches ? "light" : "dark");
});
