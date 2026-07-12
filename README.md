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

## Modular studio setup

`studio.yaml` is the public feature switchboard: it selects the site, ordinary text publishing, video publishing, YouTube Shorts, Instagram Reels and analytics. It contains no secrets. Start from `studio.video-only.example.yaml` when only a video bot is needed, then put tokens in `apps/backend/secrets.env` (ignored by Git). Creator analytics are cached once per 24 hours; it stores at most 50 recent comments per published YouTube Short or Instagram Reel for the optional local AI audience report.

Video publication is one durable workflow: choose YouTube and/or Instagram in Telegram, enter platform-specific metadata, and choose one shared time or a separate Moscow time for each platform. The bot reminds the owner five minutes before each target. Source media stays on the server until 24 hours after the final target result (published, failed, or cancelled), so one platform never deletes the file needed by the other.

```bash
cp studio.video-only.example.yaml studio.yaml
cp apps/backend/secrets.env.example apps/backend/secrets.env
bun run --filter @alexgetman/backend ops doctor
```

For Instagram Reels, `PUBLIC_BASE_URL` must be the public HTTPS address of the running service: Meta downloads the video from `/media/video/<asset>`. YouTube uses a manually-created OAuth refresh token (`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`); the token values must never be committed.

## Local Development

```bash
corepack enable
bun install --frozen-lockfile
bun run dev
```

Open `http://127.0.0.1:4321`.

## Build

```bash
bun run build
```

The build generates responsive images first and then runs `astro build`.

To run the full monorepo gate:

```bash
bun run check:all
```

That runs the Astro build and the TypeScript backend typecheck/test gate.
It also rejects Python, JavaScript and shell source files so the repository cannot drift back to a mixed-language runtime.

Backend operations are exposed through one TypeScript CLI:

```bash
bun run --filter @alexgetman/backend ops status --db ./data/pipeline.db
bun run --filter @alexgetman/backend ops backup --db ./data/pipeline.db
bun run --filter @alexgetman/backend ops audit --db ./data/pipeline.db
bun run --filter @alexgetman/backend ops capabilities --db ./data/pipeline.db
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
