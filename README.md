# alexgetman.com

Open monorepo for [alexgetman.com](https://alexgetman.com): the Astro vertical news site, publishing pipeline, site-feed API, metrics and command-center tooling.

## Repository Layout

```text
apps/
  web/       Astro site source and public assets
  backend/   Hono API, grammY bot, workers, metrics and command-center tooling
packages/
  shared/    shared TypeScript types, Zod schemas and contracts
docs/        public architecture, brand, SEO/AIO and operations notes
deploy/      nginx examples and deployment snippets
scripts/     repository-level checks and build helpers
```

Runtime secrets, SQLite databases, Telegram sessions, generated media, logs and production `.env` files are intentionally excluded from git. Use `.env.example` files only.

## Local Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run dev
```

Open `http://127.0.0.1:4321`.

## Build

```bash
pnpm run build
```

The build generates responsive images first and then runs `astro build`.

To run the full monorepo gate:

```bash
pnpm run check:all
```

That runs the Astro build and the TypeScript backend typecheck/test gate.
It also rejects Python, JavaScript and shell source files so the repository cannot drift back to a mixed-language runtime.

Backend operations are exposed through one TypeScript CLI:

```bash
pnpm --filter @alexgetman/backend ops status --db ./data/pipeline.db
pnpm --filter @alexgetman/backend ops backup --db ./data/pipeline.db
pnpm --filter @alexgetman/backend ops audit --db ./data/pipeline.db
pnpm --filter @alexgetman/backend ops capabilities --db ./data/pipeline.db
```

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
