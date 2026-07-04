# alexgetman-posting

Bot-approved publishing pipeline for `alexgetman.com`.

## What It Does

- `controller-bot` creates owner-approved posts with RU/EN text, target toggles and media.
- `posting-app` runs the controller bot, publishing bridge, metrics scheduler and observability loop in one Python process.
- Controller bot approvals support immediate publishing or automatic scheduling in the fixed MSK RU/EN slot table.
- `posting_core/publishing.py` is the publishing orchestrator. Target/API implementation is isolated behind `posting_core/clients/*`, `posting_core/media.py`, `posting_core/text.py` and `posting_core/state.py`.
- `site_feed/app.py` creates the FastAPI app; route groups live in `site_feed/*_routes.py`.
- `site_feed/cli.py` is the site-feed CLI entrypoint for render/webhook maintenance commands.
- `pipeline_metrics.py` is the metrics scheduler/orchestrator; feed import, repository writes, schedule logic and source collectors live in `posting_core/metrics/`.
- `control_plane.py` maintains lifecycle state, media assets, platform rules, credential checks, analytics rollups, public content memory and observability events.
- `capability_matrix.py` records tested media formats per platform.
- `/command-center` is a private operations UI/API for drafts, queue, retries, EN edits, EN media replacement, credentials, errors and capability state.

## Layout

- `posting/` - app entrypoint, Telegram controller bot, runners, metrics worker, control plane and media capability matrix.
- `posting_core/` - shared DB, durable per-target queue, repair service and publishing clients.
- `site_feed/` - FastAPI site-feed package, route groups and CLI entrypoints.
- `site_feed/` - likes, metrics, pipeline/ops payloads, Telegram source conversion and rendering helpers.
- `deploy/` - systemd/deployment examples.
- `scripts/` - validation, smoke, deploy, backup and restore helpers.

## Runtime State

Runtime files are intentionally not committed:

- `data/*.db`
- `data/*.json`
- `secrets.env`
- service tokens and platform credentials
- downloaded media

Use the `*.example` files as templates.

## Basic Checks

```sh
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e '.[dev]'
./scripts/check
./scripts/init-fixture-db /tmp/alexgetman-posting-fixture.db
```

## Production Notes

Production currently runs on `tw-nl`:

- unified Docker stack: `/opt/alexgetman-posting`
- compose file: `/opt/alexgetman-posting/compose.yaml`
- site source: SQLite `site_source_items` and durable `site_jobs` in `/opt/alexgetman-posting/data/pipeline.db`
- pipeline DB: `/opt/alexgetman-posting/data/pipeline.db`
- public status: `https://alexgetman.com/pipeline-status`
- private command center: `https://alexgetman.com/command-center`
- AI crawler exports: `https://alexgetman.com/content-index.json` and `https://alexgetman.com/content-memory.md`

Use `./scripts/deploy` for production sync and rebuild. Use `./scripts/backup-db` before risky DB work and `./scripts/restore-db` only with an explicit restore target.

Do not commit live `.env`, DB files, Bot API cache, media cache, tokens, command-center tokens or generated feed state.
