# Architecture

## Scope

The project is a single-process personal publishing system. The same Bun runtime serves the Astro site, accepts Telegram updates, and runs background workers. This is intentional: the workload is small, the state is local, and avoiding internal network boundaries keeps operation simple.

```text
Telegram bot / webhook / polling
              |
              v
      drafts and publication targets
              |
              v
SQLite jobs and schedules ----> platform adapters ----> social platforms
              |
              +---------------> site materialisation ----> Astro site and feeds
              |
              +---------------> metrics and creator analytics
```

## Main boundaries

| Area | Responsibility |
| --- | --- |
| `apps/web` | Astro pages, SSR endpoints, feeds, static assets, and the server entry point. |
| `apps/backend/bot` | Telegram commands, drafts, previews, schedules, and interactive control cards. |
| `apps/backend/publishing` | Durable text-publication jobs, retries, locking, scheduling, and state transitions. |
| `apps/backend/video` | Video draft lifecycle, preparation, reminders, platform targets, and retention. |
| `apps/backend/social` | Platform-specific publishing adapters. |
| `apps/backend/metrics` and `analytics` | Metric collection, checkpoints, creator reports, and audience analysis. |
| `apps/backend/admin` | Command Center read models and authorised repair actions. |
| `apps/backend/ops` | Backup, audit, capability, migration, and verification commands. |

## State

SQLite is the authoritative state store for drafts, posts, publication targets, jobs, schedules, operational events, and metrics. It runs in WAL mode with a busy timeout and foreign keys enabled.

Drizzle has two roles:

1. `src/db/schema.ts` describes tables, indexes, and typed query shapes.
2. `apps/backend/drizzle/*.sql` is the append-only migration history applied to existing databases at runtime.

Changing the TypeScript schema alone does not change a running database. A schema change needs a reviewed SQL migration. Do not delete or rewrite migrations that have reached production.

Some analytics and atomic counters use direct prepared SQLite statements. That is deliberate: Drizzle is a typed SQL layer, not a prohibition on SQL.

## Configuration

`studio.yaml` selects public, secret-free feature modules. Environment variables hold credentials and deployment-specific paths. Zod validates configuration at startup and validates untrusted structured data at application boundaries.

## Failure model

Each external publication target is independent. A post may succeed on one platform and fail on another; completed targets are not re-published when a remaining target retries. Jobs have claims, locks, retry backoff, and terminal states. The Command Center and `ops verify` expose the resulting state.
