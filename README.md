[English](README.md) · [Русский](README.ru.md)

# Solo Publisher

**Write in chat. Publish everywhere. Own the stack.**

Solo Publisher is an agent-native, self-hosted publishing studio for solo creators. Write from Telegram or an MCP client such as Codex, then publish to your website and social channels with durable scheduling, independent retries, media processing, and creator analytics.

[Live site](https://alexgetman.com) · [Install](#install) · [Production architecture](#how-it-works)

![A live publication powered by Solo Publisher](docs/assets/live-site.png)

> This is not a starter kit or a mockup. Solo Publisher runs the complete publishing pipeline behind [alexgetman.com](https://alexgetman.com) in production.

## The workflow

```text
You: Publish this tomorrow at 09:00 in Russian and English.

Solo Publisher:
✓ Draft created and validated
✓ Media prepared
✓ Website, Telegram, X, and Threads scheduled
✓ Every destination will be delivered and retried independently
```

One conversation replaces the usual chain of CMS tabs, social schedulers, media tools, and spreadsheets. The website and every connected channel are destinations of the same durable publication rather than separate copies you have to keep in sync.

## Built for one creator

Solo Publisher deliberately serves one owner instead of reproducing agency software. There are no organizations, seats, approval committees, workspace hierarchies, or per-channel subscriptions.

- **Chat-native authoring** — create, edit, preview, schedule, and publish from a private Telegram bot.
- **Agent-native control** — the same Studio is exposed through MCP, so Codex and other compatible clients can write, publish, inspect analytics, and diagnose delivery.
- **Owned website** — an Astro publication site with bilingual pages, feeds, search, sitemap, structured metadata, Markdown endpoints, and an interactive story reader.
- **Durable delivery** — SQLite stores schedules, jobs, targets, retries, and external IDs. A failure on one platform does not invalidate the destinations that succeeded.
- **Text and short-form video** — publish text and media to Telegram, X, and Threads; run optional YouTube Shorts and Instagram Reels or Stories workflows.
- **Creator analytics** — collect publication metrics, audience snapshots, and operational state in one private Command Center.
- **Self-hosted by default** — your content, credentials, database, media, domain, and deployment stay under your control.

![Solo Publisher Command Center with text and video analytics](docs/assets/command-center.png)

## Install

Requirements: Docker, and a domain whose DNS already points at the machine. The image is published for linux/amd64 and linux/arm64, so an ARM server needs no build.

```bash
git clone https://github.com/alexgetmancom/solo-publisher.git
cd solo-publisher
cp .env.example .env
```

Set `DOMAIN` in `.env`, then generate the two secrets it asks for:

```bash
openssl rand -hex 32
```

```bash
docker compose up -d
```

Caddy obtains and renews the TLS certificate itself, so there is no certbot and no renewal timer to set up. Within a minute the Command Center is at `https://your-domain/command-center`. Sign in with the `COMMAND_CENTER_TOKEN` from `.env`; an empty Studio opens with the three steps to its first draft instead of an empty analytics screen.

The public website is off by default — most Studios publish to channels they already have and do not want another site to look after. Enable it with the operations CLI shipped in the container:

```bash
docker compose exec app bun /app/ops/cli.js studio-profile-set --site-enabled
```

It appears at `https://your-domain/`, with its feeds, sitemap and Markdown endpoints, on the next request.

Temporary media that an external platform fetches during publishing is staged under `/data/media`, automatically created and owned by the container before the app drops privileges. The `/media/staging/` route remains available when the public site is off, so a fresh self-host does not need a manual directory or permission step.

Only Caddy publishes ports; the application is reachable through it alone. Nothing else in `.env` is required to start — a Studio with no platform credentials serves its Command Center and publishes nowhere. Add Telegram or MCP as the authoring interface, then connect destinations from Command Center → Studio; `docker compose exec app bun /app/ops/cli.js doctor` lists what each enabled destination still needs.

`docker compose exec app bun /app/ops/cli.js studio-profile` shows what this Studio publishes as, its time zone, whether it serves a public site, and video timing; `studio-profile-set` on the same CLI changes them. They live in the database, so they survive a redeploy and need no restart.

Before an update, `docker compose exec app bun /app/ops/cli.js status` reports the running `gitRevision`. `latest` follows the revision running in the maintainer's production; set `SOLO_PUBLISHER_IMAGE=ghcr.io/alexgetmancom/solo-publisher:<full-gitRevision>` in `.env` when you want the verified installation to stay fixed. Update with `docker compose pull && docker compose up -d`; diagnose with `docker compose logs -f app`.

Two things worth knowing on day one. When Telegram is configured, the Studio sends you a copy of its database
every day, silently, in the same Telegram chat you author from; it covers posts,
schedules, delivery state and analytics, but **not** media files, which are far
larger than Telegram accepts. Those have their own command:
`docker compose exec app bun /app/ops/cli.js backup-media` archives video,
posters, story cards and site assets into `BACKUP_DIR_HOST`, which must not be
the volume it is protecting — run it on a schedule, because `doctor` reports the
deployment unhealthy until an archive newer than a week is there. Turn the
database copy off under Settings → Notifications → Database backup. And Telegram refuses file
downloads over 50 MB, which is smaller than a short video: to publish video, set
`TELEGRAM_API_ID`, `TELEGRAM_API_HASH` and `COMPOSE_PROFILES=telegram` in `.env`,
which starts a local Bot API server alongside the app and lifts the limit to 2 GB.

## Connect a destination

Two halves, deliberately separate: the Studio has to know a destination exists,
and it has to hold the credentials for it.

```bash
docker compose exec app bun /app/ops/cli.js channel-connect --target threads_en
docker compose exec app bun /app/ops/cli.js doctor
```

`doctor` names the exact settings that destination is still missing, and never
prints the ones it has. The same two steps work from the Telegram bot and from
an MCP client.

**[Connecting a destination](docs/destinations.md)** covers every platform: what
each one needs, when to go through a provider instead of registering your own
Meta app, the guided flow for YouTube, and the things that bite later — a Threads
token that lapses after 60 days, X charging for writes, and the 50 MB download
limit that stops video until a local Bot API is running.

**[Backups](docs/backups.md)** — what arrives on its own and what you point your
own tool at. **[Operating from an agent](docs/mcp.md)** — turning on the MCP
transport and connecting a client to it.

## Try it without installing

Requirements: [Bun 1.3.14](https://bun.sh/) and the native build prerequisites required by `sharp`.

```bash
bun install --frozen-lockfile
bun run demo
```

The demo creates deterministic fixture content, builds the production Astro bundle, and starts the complete Bun runtime without requiring Telegram or social-platform credentials.

- Public site: <http://localhost:8788/>
- Command Center: <http://localhost:8788/command-center?token=dev>

The fixture is deliberately not all-green: it includes enough history, delivery state, and analytics to make the operational views useful. Stop the server with `Ctrl+C`; run `bun run demo` again to rebuild the fixture from scratch.

## Running it from source

Copy the secret template:

```bash
cp apps/backend/secrets.env.example apps/backend/secrets.env
```

What a Studio publishes as, whether it serves the public site, its time zone and video timing live in its own database, read and written with `bun run --filter @solo-publisher/backend ops -- studio-profile`. Credentials stay in the ignored `apps/backend/secrets.env`; connected destinations live in the channel registry. Text posting, video posting and analytics always run.

The private Telegram bot and MCP endpoint operate the same Studio services. Posts created through either interface land in the same drafts, schedules, publication jobs, and analytics.

For an MCP client on another machine, the bundled [`studio` plugin](plugin/README.md) packages the remote transport and the operating skill. Its [setup prompt](plugin/setup-prompt.md) connects and verifies a deployment without exposing its database or SSH access.

## Supported destinations

| Destination | Text | Media | Short video | Analytics |
| --- | :---: | :---: | :---: | :---: |
| Website | ✓ | ✓ | — | ✓ |
| Telegram channel | ✓ | ✓ | — | ✓ |
| Telegram Stories | — | ✓ | ✓ | — |
| X | ✓ | ✓ | — | ✓ |
| Threads | ✓ | ✓ | — | ✓ |
| YouTube Shorts | — | — | ✓ | ✓ |
| Instagram Reels / Stories | — | ✓ | ✓ | ✓ |

Availability depends on the channels connected to the Studio and their credentials. Solo Publisher uses your own platform accounts and API credentials; it is not an aggregator sitting between you and your audience.

## How it works

```mermaid
flowchart LR
  Telegram["Telegram bot"] --> Studio["Studio services"]
  MCP["MCP client"] --> Studio
  Studio --> Content["Drafts and media"]
  Studio --> Queue["Durable publication jobs"]
  Content --> DB[("SQLite")]
  Queue --> DB
  DB --> Workers["Delivery workers"]
  Workers --> Site["Astro site"]
  Workers --> Social["Telegram · X · Threads"]
  Workers --> Video["YouTube · Instagram"]
  Social --> Analytics["Creator analytics"]
  Video --> Analytics
  Analytics --> DB
```

The core is intentionally small: Telegram and MCP are command adapters over the same Studio services. Those services create durable SQLite publication jobs; workers deliver each target independently. The private Command Center and operations CLI read and maintain that same state.

Heavy media processing can run locally with ffmpeg or through the included remote HTTP worker. The remote worker performs hardware-accelerated transforms without taking over Telegram polling or the durable queues. See [`deploy/media-processor`](deploy/media-processor/README.md).

## Stack

- Bun and TypeScript
- Astro and Svelte
- grammY and MTProto
- SQLite and Drizzle ORM
- MCP over HTTP
- ffmpeg and sharp
- Docker Compose, Caddy, and immutable-image deployment

There is no Redis, RabbitMQ, separate database server, or multi-tenant application layer.

## Development

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

`bun run check:all` runs the full repository gate. Production deployment is intentionally specific to the live alexgetman.com installation; self-hosters should treat the committed deployment files as an implementation reference and supply their own domains, credentials, storage paths, and host configuration.

## Security

Runtime secrets, SQLite databases, Telegram sessions, generated media, logs, and production environment files are excluded from Git. Never commit a token, OAuth refresh token, session, or production data export.

The production container starts as root only to fix ownership on dedicated bind-mounted data directories, then irreversibly drops to an unprivileged user before loading the server. Do not point those mounts at shared host directories.

## License

Licensed under the [Apache License 2.0](LICENSE).
