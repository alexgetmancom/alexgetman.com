# Workflow

- Work only on `main`; do not create branches or PRs.
- Before every push: typecheck, tests, and production build.
- Push directly to `main`; CI/CD is the only production deploy path.

## Tatically after 2026-07-15. All other production deployments remain CI/CD-only.

## Runtime diagnostics

- Production SSH alias: `ssh tw-nl`. Подключаться только когда задача требует production-диагностики; доступ read-only.
- Перед анализом worker, очереди, конфигурации или публикации сначала использовать существующий read-only JSON CLI, а не искать состояние по исходникам:
  - `bun run --filter @alexgetman/backend ops status`
  - `bun run --filter @alexgetman/backend ops doctor`
  - `bun run --filter @alexgetman/backend ops audit`
  - `bun run --filter @alexgetman/backend ops capabilities`
  - `bun run --filter @alexgetman/backend ops verify --ref post:<id>`
- Для авторизованной диагностики конкретного поста использовать JSON endpoint `/api/post-debug?ref=post:<id>`; он показывает post, targets и publish jobs.
- Не запускать `backup`, `restore`, `metrics-backfill --apply`, `capability-record`, retry/republish или другие мутации без явного запроса пользователя.
