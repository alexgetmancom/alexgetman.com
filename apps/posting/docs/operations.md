# Operations

## Deploy Shape

Root `compose.yaml` defines the production Docker stack:

- `bot-api`
- `posting-app`
- `site-feed`

Production path on `tw-nl`: `/opt/alexgetman-posting`.

Runtime env/data files stay beside the compose file and are excluded from Git:

- `secrets.env`
- `telegram-bot-api.env`
- `site-feed.env`
- `data/`
- `bot-api-data/`
- `bot-api-temp/`

## Bot-Approved Flow

1. Owner creates a post through the Telegram controller bot.
2. Controller bot applies the platform capability router and writes durable state into SQLite first:
   - `publish_plans`
   - `publish_jobs`
   - `site_source_items`
3. Runtime coordination stays in SQLite. The old queue/plan/state/site-source JSON files are not read paths anymore.
4. Social bridge claims due per-target jobs from SQLite (`queued -> publishing`) through `posting_core.queue` and publishes enabled targets concurrently where possible.
5. Publisher writes `publish_jobs`, `post_targets` and `post_events` immediately after every target result. `pipeline_metrics.py` is no longer the only importer of social target status.
6. Site feed claims due `site_jobs`, reads `site_source_items`, updates `feed.json` and rebuilds site pages atomically.
7. Metrics loop updates `pipeline.db` and calls the control plane sync.
8. Observability loop sends owner alerts for fresh warn/error events with cooldown/dedup for identical alerts.

## Command Center

Private endpoint: `https://alexgetman.com/command-center`.

It requires `COMMAND_CENTER_TOKEN` through `X-Command-Token`, `?token=...`, or `command_token` cookie. The page and JSON API expose:

- drafts, queue and processed state
- lifecycle state and target errors
- credential readiness without secret values
- media assets and hashes when local files are available
- capability matrix/platform rules
- retry/republish, EN text edits, EN media JSON replacement and RU-media fallback

## SQLite Control Plane

`pipeline.db` is the historical database. Besides pipeline status tables it contains:

- `drafts`
- `admin_state`
- `pending_albums`
- `publish_jobs`
- `publish_plans`
- `site_source_items`
- `site_jobs`
- `worker_state`
- `ops_actions`
- `post_lifecycle`
- `post_events`
- `media_assets`
- `platform_rules`
- `credential_checks`
- `content_memory`
- `analytics_rollups`
- `deployment_snapshots`
- `alert_dedup`

`publish_jobs` is the authoritative social publishing queue. Durable statuses are `queued`, `publishing`, `published`, `failed` and `cancelled`.

`site_jobs` is the authoritative site rebuild queue. The site worker claims `queued -> rendering`, retries transient build failures with backoff and writes build events/status into SQLite.

`post_events` uses `severity` (`info`, `warn`, `error`) and `acked_at` for alerting. Identical owner alerts are suppressed for `ALERT_COOLDOWN_SECONDS`.

`posting-app` runs bridge, controller, metrics and observability in one Python process through `posting/app.py`. One-shot inspection commands:

Controller bot state lives in `pipeline.db`. The old `/opt/alexgetman-posting/data/controller.db` is retired; deploy moves it to `data/backups/` if it is still present.

```sh
docker compose exec -T posting-app python /app/control_plane.py health
docker compose exec -T posting-app python /app/control_plane.py json
docker compose exec -T posting-app python /app/control_plane.py backup
```

## Production Checks

```sh
ssh tw-nl s
ssh tw-nl 'cd /opt/alexgetman-posting && docker compose ps'
ssh tw-nl 'curl -fsS -o /dev/null -w "%{http_code}\n" https://alexgetman.com/pipeline-status'
ssh tw-nl 'curl -fsS -o /dev/null -w "%{http_code}\n" https://alexgetman.com/api/pipeline-status'
ssh tw-nl 'curl -fsS -o /dev/null -w "%{http_code}\n" https://alexgetman.com/content-index.json'
```

## Deploy

Use:

```sh
./scripts/deploy
```

The script compiles Python, scans for common secret patterns, takes a DB copy on the host, syncs code into `/opt/alexgetman-posting` without runtime files, rebuilds the stack and runs `./scripts/smoke`.

`site-feed` must bind to `0.0.0.0` inside Docker through `BIND_HOST=0.0.0.0`; the host port remains loopback-only through `127.0.0.1:8788:8788`.

Backup/restore helpers:

```sh
./scripts/backup-db
./scripts/restore-db /opt/alexgetman-posting/data/backups/<file>.db
```

## Safety

- Do not commit runtime JSON files or DBs.
- Do not commit generated media.
- Do not commit service credentials.
- Do not expose `COMMAND_CENTER_TOKEN` in chat, logs or docs.

# Scheduled publishing

The controller bot preview offers `Publish now` and `Schedule`.

`Schedule` assigns drafts to the fixed MSK slot table, with up to five posts per day. Telegram, Site RU and RU social targets start at the RU slot. Site EN and EN social targets wait for the paired EN slot. Business scheduling uses `publish_at`; retry backoff remains in `next_attempt_at`.
