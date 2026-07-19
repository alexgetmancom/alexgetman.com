# alexgetman.com

`alexgetman.com` is an open, self-hosted personal publishing system. It combines an Astro news site with a private Telegram control bot, durable social publishing, creator analytics, and production operations tooling.

It is designed for a small editorial workflow rather than as a multi-tenant CMS or SaaS product.

## What it does

- Publishes bilingual Russian and English posts to the site and selected social platforms from Telegram.
- Keeps publication targets, schedules, retries, and external IDs in SQLite so a partial platform failure does not invalidate the rest of a publication.
- Supports optional video workflows for YouTube Shorts and Instagram Reels, including independent schedules and source-media retention.
- Serves an Astro site with feeds, sitemap, structured metadata, search, and machine-readable endpoints.
- Collects publication and creator metrics, exposes a private Command Center, and sends operational alerts to the owner.

## Stack

- Bun and TypeScript
- Astro with the Node adapter for the public site and SSR endpoints
- grammY for the private Telegram bot
- SQLite via `bun:sqlite`, Drizzle ORM, and versioned SQL migrations
- Zod for runtime configuration and untrusted payload validation
- Docker Compose, nginx, GitHub Actions, and immutable image deployment

The HTTP layer uses standard `Request` and `Response` objects. There is no Hono, Express, Redis, RabbitMQ, or separate database server.

## Repository layout

```text
apps/
  web/       Astro pages, components, feeds, and the server entry point
  backend/   bot, API controller, workers, publishing, metrics, and operations
deploy/      Docker, nginx, deployment-agent, and production runbook material
scripts/     repository checks and build helpers
```

The main path is deliberately small: Telegram, MCP, and the private web Studio
are adapters over the same Studio services; those services create durable SQLite
publication jobs; workers deliver them to the site and social platforms. The
Command Center and operations CLI only read or explicitly maintain that state.

## Local development

Requirements: Bun `1.3.14` and the usual native build prerequisites for `sharp`.

```bash
bun install --frozen-lockfile
cp apps/backend/secrets.env.example apps/backend/secrets.env
bun run dev
```

The site is available at `http://127.0.0.1:4321`.

`studio.yaml` is a committed, secret-free feature switchboard. It controls the site, text publishing, video publishing, platform modules, and analytics. Keep tokens and private credentials in the ignored `apps/backend/secrets.env` file.

For a video-only bot configuration:

```bash
cp studio.video-only.example.yaml studio.yaml
bun run --filter @alexgetman/backend ops doctor
```

## Quality checks

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

`bun run check:all` runs the repository gate. Git hooks run the same important checks before a push; CI builds the production image and is the only production deployment path.

## Operations

The backend CLI is intentionally split between read-only diagnostics and explicit maintenance commands:

```bash
bun run --filter @alexgetman/backend ops status --db ./data/pipeline.db
bun run --filter @alexgetman/backend ops doctor
bun run --filter @alexgetman/backend ops audit --db ./data/pipeline.db
bun run --filter @alexgetman/backend ops verify --ref post:123
```

Production images contain the same bundled CLI. The production deployment and
read-only diagnostics are documented in [deploy/README.md](deploy/README.md).
`AGENTS.md` is the working runbook for agents: follow it before inspecting or
changing production state.

## Security and privacy

Runtime secrets, SQLite databases, Telegram sessions, generated media, logs, and production environment files are intentionally excluded from Git. The repository contains examples only; never commit a token, OAuth refresh token, session, or production data export.
