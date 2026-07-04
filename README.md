# alexgetman.com

Open monorepo for [alexgetman.com](https://alexgetman.com): the Astro vertical news site, publishing pipeline, site-feed API, metrics and command-center tooling.

## Repository Layout

```text
apps/
  web/       Astro site source and public assets
  posting/   publishing pipeline, site-feed API, metrics, Telegram controller and tests
docs/        public architecture, brand, SEO/AIO and operations notes
deploy/      nginx examples and deployment snippets
scripts/     repository-level checks and build helpers
```

Runtime secrets, SQLite databases, Telegram sessions, generated media, logs and production `.env` files are intentionally excluded from git. Use `.env.example` files only.

## Local Development

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4321`.

## Build

```bash
npm run build
```

The build generates responsive images first and then runs `astro build`.

To run the full monorepo gate:

```bash
npm run check:all
```

That runs the web build and, when Python dev dependencies are available, the posting pipeline checks from `apps/posting`.

## Content

Runtime post data is read from `DATA_DIR/feed.json` in production and falls back to `apps/web/src/data/feed.json` locally.

Public routes include:

- `/` — English home and feed.
- `/ru/` — Russian home and feed.
- `/{post_id}/{english-slug}/` — English posts.
- `/ru/{post_id}/{russian-slug}/` — Russian posts.
- `/feed.xml`, `/feed.json`, `/ru/feed.xml`, `/ru/feed.json` — feeds.
- `/about`, `/ru/about`, `/privacy`, `/ru/privacy` — static SEO and policy pages.

Nginx cache rules live in `deploy/nginx/`.

## Docs

- `docs/plans.md` is the current public roadmap.
- `docs/social-links.md` documents the official profiles, feeds, and publishing targets.
