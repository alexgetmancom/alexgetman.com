# Self-hosting plan

## Goal

Make the existing application practical to deploy as a personal, self-hosted
Telegram publishing system without changing its production architecture or
creating a separate community edition.

The supported first-run experience should be:

```text
install a released Docker image
  -> provide Telegram and owner credentials
  -> start one Compose stack
  -> verify it with ops doctor
```

The production deployment remains separate and continues to use its own Compose
file, nginx topology, media mounts, local Telegram Bot API, and deployment agent.

## First supported profile

The first self-hosted profile intentionally stays small:

- one owner;
- Telegram long polling;
- SQLite stored in a Docker volume;
- ordinary text publishing;
- no public website, video workflow, Stories, analytics, or social publishers by
  default.

Features are enabled later through `studio.yaml` and their documented credentials.

## Files

Add a dedicated, releaseable directory:

```text
selfhosted/
  compose.yaml
  studio.yaml
  secrets.env.example
  install.sh
```

`compose.yaml` uses the existing published backend image. It must not require
host-specific paths, external Docker networks, nginx, a deployment agent, or a
local Telegram Bot API. Persistent application state belongs in named Docker
volumes.

The default `studio.yaml` enables only the minimal profile. `secrets.env.example`
contains only the required values:

```dotenv
CONTROLLER_BOT_TOKEN=
ADMIN_IDS=
COMMAND_CENTER_TOKEN=
```

`TELEGRAM_API_BASE_URL` uses the official Telegram API and polling is enabled.
The production local Bot API remains an optional deployment-specific override.

## Installer

The installer is a convenience wrapper around Compose, not a second deployment
system. It should:

1. Check for Docker and Docker Compose.
2. Ask for an installation directory.
3. Download self-hosted files for a pinned release version.
4. Prompt for the Telegram bot token, owner Telegram ID, and Command Center token.
5. Write `secrets.env` with restrictive permissions.
6. Run `docker compose pull` and `docker compose up -d`.
7. Run `docker compose exec backend bun /app/ops/cli.js doctor`.
8. Print update, diagnostics, logs, and backup commands.

The installer must never send entered credentials anywhere, create SSH access,
depend on a private host path, or silently enable external publishing platforms.

Users may choose a convenience command:

```bash
curl -fsSL https://raw.githubusercontent.com/alexgetmancom/alexgetman.com/<release>/selfhosted/install.sh | bash
```

The documentation must also show an inspectable alternative:

```bash
curl -fsSLO https://raw.githubusercontent.com/alexgetmancom/alexgetman.com/<release>/selfhosted/install.sh
less install.sh
bash install.sh
```

Use a release tag or immutable commit, never a moving `main` reference, for a
production installation.

## Small product improvements

- Add a bot command that returns the caller's Telegram user ID, so users can fill
  `ADMIN_IDS` without trusting a third-party bot.
- Document each optional module separately: public site, webhook, social target,
  video publishing, and backups.
- Add a CI smoke test that starts the self-hosted Compose profile with polling
  disabled and checks `/readyz`.

## Non-goals

- No multi-tenant hosting or user management.
- No separate codebase or feature fork.
- No automatic migration to Redis, PostgreSQL, or a message broker.
- No support claim for every social integration in the first self-hosted release.
