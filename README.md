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

The HTTP layer speaks standard `Request` and `Response` objects; Hono is used only as the router that assembles the backend API (`apps/backend/src/api.ts`). There is no Express, Redis, RabbitMQ, or separate database server.

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
bun run --filter @alexgetman/backend ops usage --days 30 --unused-days 90 --db ./data/pipeline.db
bun run --filter @alexgetman/backend ops verify --ref post:123
```

Production images contain the same bundled CLI. The production deployment and
read-only diagnostics are documented in [deploy/README.md](deploy/README.md).
`AGENTS.md` is the working runbook for agents: follow it before inspecting or
changing production state.

## Container permissions

The image starts as root and drops to the unprivileged `bun` user (uid/gid 1000)
before the server loads — see
[apps/backend/src/runtime/docker-entrypoint.ts](apps/backend/src/runtime/docker-entrypoint.ts).
The root phase exists only to `chown` the configured data directories: Docker
creates a bind-mount target that does not exist yet as root, and without this a
fresh deployment fails much later with a permission error on the first upload
rather than at boot. The drop is irreversible (`setuid` from root also replaces
the saved uid), so the server cannot regain root. Two consequences when you
deploy this yourself:

- The directories listed in `DATA_DIR`, `MEDIA_CACHE_DIR`, `VIDEO_MEDIA_DIR` and
  `SITE_PUBLIC_DIR` get their owner set to 1000:1000 at boot. Point them at
  paths dedicated to this app, not at a directory shared with other services.
- To read videos downloaded by the local Telegram Bot API server, the container
  needs that server's data group: `group_add: ["${BOT_API_GID:-101}"]` in the
  compose file. Set `BOT_API_GID` to the group owning your bot-api data
  directory (`stat -c %g <bot-api-data>`). The entrypoint preserves every group
  Docker grants the container; it cannot add one that was never granted.

Do not add a `command:` override for the backend service — the entrypoint loads
the server itself, and anything passed as a command becomes an ignored argument
instead of a Bun flag.

## Security and privacy

Runtime secrets, SQLite databases, Telegram sessions, generated media, logs, and production environment files are intentionally excluded from Git. The repository contains examples only; never commit a token, OAuth refresh token, session, or production data export.
