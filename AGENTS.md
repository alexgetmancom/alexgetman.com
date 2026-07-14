# Workflow

- Work only on `main`; do not create branches or PRs.
- Before every push: typecheck, tests, and production build.
- Push directly to `main`; CI/CD is the only production deploy path.

## Tatically after 2026-07-15. All other production deployments remain CI/CD-only.

## Runtime diagnostics

- Production SSH alias: `ssh tw-nl`. Подключаться только когда задача требует production-диагностики; доступ read-only.
- Перед анализом worker, очередей, конфигурации, публикаций или ошибок сначала выполнить CLI локально. Это проверяет контракт и доступность команды, но локальная БД/volumes могут отсутствовать:
  - `bun run --filter @alexgetman/backend ops status`
  - `bun run --filter @alexgetman/backend ops doctor`
  - `bun run --filter @alexgetman/backend ops audit`
  - `bun run --filter @alexgetman/backend ops capabilities`
  - `bun run --filter @alexgetman/backend ops verify --ref post:<id>`
- Сразу после этого, если нужен фактический production-state, выполнить те же команды на сервере через уже запущенный контейнер: `ssh tw-nl 'docker exec alexgetman-backend bun /app/ops/cli.js <command>'`. Начинать со `status`, `doctor`, `audit`; для конкретного поста — `verify --ref post:<id>`. Не искать состояние по исходникам, пока не получен CLI output.
- Если локальная команда завершается `EROFS`, `ENOENT` или из-за отсутствующих локальных `/data`/secrets, не исправлять это ради диагностики: за production-ответом идти к read-only CLI в контейнере.
- Для авторизованной диагностики конкретного поста использовать JSON endpoint `/api/post-debug?ref=post:<id>`; он показывает post, targets и publish jobs.
- Не запускать `backup`, `restore`, `metrics-backfill --apply`, `capability-record`, retry/republish или другие мутации без явного запроса пользователя.
