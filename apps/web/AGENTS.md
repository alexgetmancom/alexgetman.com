# Theming

Two skins, one vocabulary: `src/shared/styles/tokens.css` and
`apps/backend/src/interfaces/web/dashboard/theme.ts`. Names match, values deliberately do not.
`themeContract.test.ts` fails if a shared token is missing from either file in either theme.
**Never write a raw colour in CSS** — only `var(--*)`. The theme is `data-theme` on `<html>`, set by
an inline script before first paint.

Player chrome has its own rules in `src/scripts/story-player/AGENTS.md`.
