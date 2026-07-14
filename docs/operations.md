# Operations

## Deployment

Only GitHub Actions deploys production. It builds an immutable Docker image, activates it through the private deployment agent, checks `/readyz`, and rolls back to the prior image digest if activation fails.

Do not deploy manually from a workstation or alter production data during a routine investigation.

## Read-only diagnostics

Run the following commands locally against a chosen database:

```bash
bun run --filter @alexgetman/backend ops status --db ./data/pipeline.db
bun run --filter @alexgetman/backend ops doctor
bun run --filter @alexgetman/backend ops audit --db ./data/pipeline.db
bun run --filter @alexgetman/backend ops verify --ref post:123
```

The production image contains the same CLI:

```bash
docker exec alexgetman-backend bun /app/ops/cli.js status
docker exec alexgetman-backend bun /app/ops/cli.js doctor
docker exec alexgetman-backend bun /app/ops/cli.js audit
```

`backup`, `restore`, `metrics-backfill --apply`, capability recording, and retry or republish commands mutate state. Use them only as part of an explicit maintenance task.

For an authorised post-specific view, use the private `/api/post-debug?ref=post:<id>` endpoint or `ops verify`.

## Logs and alerts

The application writes structured JSON to stdout. Docker collects these logs; there is no separate logging service. `LOG_LEVEL=info` is the production default. Use `debug` only while investigating a specific issue.

The observability worker records failed jobs and credential checks in SQLite, deduplicates repeated alerts, and can notify the owner through Telegram.

## Backups

The offsite backup job stores encrypted restic snapshots of the production database, runtime configuration, site media, video media, Telegram Bot API data, and deployment state. It retains daily, weekly, and monthly snapshots and runs a regular database restore drill with SQLite integrity checking.

Before changing migrations or deleting runtime data, confirm that a recent backup and restore drill succeeded.

## Incident first steps

1. Check `/readyz` and the Docker health state.
2. Run `status`, `doctor`, and `audit`.
3. For one post, inspect `ops verify --ref post:<id>` or `/api/post-debug`.
4. Read recent structured logs for the target and error message.
5. Prefer an authorised repair action over manually editing SQLite.
