# Feature: story-player (the news player on the home page)

The site's only interactive feature. Everything about the player lives here — if
you are editing the player and find yourself in a file outside this folder, you
are most likely in the wrong place.

## Folder map

```
story-player/
├── StoryPlayer.svelte    ← ROOT. All player state (which post is active,
│                            pause, sound, reading mode, feed mode)
│                            + keyboard, swipes, mouse wheel. One per page.
├── StoryRail.svelte      ← the card rail on the left (post selection)
├── StoryVisual.svelte    ← centre: photo/video, progress bar, mobile buttons
├── StoryContext.svelte   ← right panel: post body, Read more, Share
├── i18n.ts               ← EVERY interface string (en/ru). New label goes here.
├── config.ts             ← breakpoint, timings. Constants go here.
├── payload.ts            ← prepares post data for the player (server, SSR)
└── state/                → still lives in scripts/story-player/ (see below)
```

The pure logic — state machines and controllers — is still imported from
`src/scripts/story-player/`. It is framework-independent and covered by tests:
`audio-state.ts` (sound/autoplay), `progress.ts` (progress and auto-advance),
`analytics.ts`, `gestures.ts` (swipes and tap zones), `media.ts` (preloading
neighbouring media). Once the old player is gone, move these into `state/` and
`controllers/` here.

## How it works (data flow)

1. The page (`pages/index.astro` and friends) loads posts from the database and
   passes them to `components/HomeNewsPage.astro`.
2. `HomeNewsPage.astro` (the Astro layer) owns SEO: the noscript article with
   the single `<h1>`, the preload of the first image. It renders the player as
   `<StoryPlayer client:load />` — a Svelte island with SSR, so the first frame
   arrives as finished HTML before any JS loads.
3. Inside the island the state is reactive: change `active` and Svelte repaints
   rail/visual/context itself. NO hand-written DOM work to reflect state — no
   `element.hidden = …`, that is a past life.

## Where new things go

- **A new button or label** → the string in `i18n.ts`, the markup in the
  matching `.svelte`, and the handler as a callback from `StoryPlayer.svelte`
  if it touches shared state.
- **New state** (favourites, say) → `$state` in `StoryPlayer.svelte`; if the
  transitions are non-trivial, a pure function in its own file plus a test
  (`scripts/story-player/audio-state.ts` is the pattern).
- **Styles** → the `<style>` block of the matching `.svelte` component
  (scoped). Every player style is already there; the only global one left is
  `styles/home-news-page.css`, which cannot be scoped because it carries the
  body class and the noscript SEO. Rules that depend on a root class
  (`.is-reading` and the like) go through `:global(.story-player.is-…)`.
  z-index is `var(--z-*)` from `shared/styles/tokens.css`, never a number.
- **A genuinely different feature** (not the player) → a new
  `features/<name>/` folder with a README like this one; pages stay thin.

## What must NOT happen here

- SEO (title, canonical, JSON-LD, h1) is the Astro layer
  (`HomeNewsPage.astro`, `layouts/Layout.astro`). The player knows nothing
  about SEO.
- Reaching into the database — data arrives ready through `payload.ts`.
- Direct DOM manipulation for UI state; only Svelte reactivity. The exceptions
  are the media API (`video.play()`) and the progress timers, and those live in
  the controllers.

## Checks

`bun run check:svelte` runs svelte-check (template types, unused CSS, a11y) and
is part of pre-push. The tool lives in `tools/svelte-check/` with its own
TypeScript 5.x, because the repository root is on TypeScript 7 (tsgo), whose
JS API svelte-check does not understand yet.

The old vanilla player is deleted (see git history: `scripts/home-news-player.ts`,
`dom.ts`, `render-frame.ts`, `components/home-news/Story*.astro`). To roll back,
revert those commits.
