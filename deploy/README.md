# Production deployment agent

`deploy-agent.ts` is intentionally a small host-side Bun service. It is the only
component allowed to invoke Docker. The Astro application never mounts the Docker
socket and can only request a rollback using a private bearer-authenticated route.

## One-time host setup

1. Create stable runtime directories. Keep configuration and the SQLite databases
   on the system disk, but use the mounted data disk for disposable media:

   ```text
   /home/deploy/alexgetman-runtime/compose.yaml
   /home/deploy/alexgetman-runtime/secrets.env
   /home/deploy/alexgetman-runtime/site-feed.env
   /home/deploy/alexgetman-runtime/deploy-image.env
   /home/deploy/maru/maru.compose.yaml
   /home/deploy/maru/secrets.env
   /home/deploy/maru/studio.yaml
   /home/deploy/maru/deploy-image.env
   ```

   `deploy-image.env` must initially contain the immutable image that is currently
   working, for example `BACKEND_IMAGE=ghcr.io/alexgetmancom/alexgetman-backend@sha256:...`.
   Never seed it with `latest`; rollback is deliberately refused without a digest.

2. Copy `deploy-agent.env.example` to `/etc/alexgetman/deploy-agent.env`, fill the
   token/chat values, and set mode `0600`. Set `DEPLOY_AGENT_HOST` to the gateway
   address of the Docker network used by the backends (obtain it with
   `docker network inspect agent_default`). Set `DEPLOY_TARGETS_JSON` exactly as
   shown in that example: it gives Alex and Maru independent health checks and
   rollback histories. Maru's host health endpoint must be bound to `127.0.0.1:8789`.

   Add the following non-secret host paths to the corresponding `deploy-image.env`
   files before the first deployment. The directories must exist on the mounted
   `/mnt/alex-media` disk and be owned by `deploy`:

   ```dotenv
   # /home/deploy/alexgetman-runtime/deploy-image.env
   ALEX_MEDIA_CACHE_DIR_HOST=/mnt/alex-media/alex/media-cache
   ALEX_VIDEO_MEDIA_DIR_HOST=/mnt/alex-media/alex/video-media
   ALEX_THREADS_MEDIA_DIR_HOST=/home/deploy/ialexey-web/media/threads
   ALEX_SITE_MEDIA_DIR_HOST=/home/deploy/ialexey-web/media
   DEPLOY_AGENT_HOST_GATEWAY=<agent_default gateway>

   # /home/deploy/maru/deploy-image.env
   MARU_MEDIA_CACHE_DIR_HOST=/mnt/alex-media/maru/media-cache
   MARU_VIDEO_MEDIA_DIR_HOST=/mnt/alex-media/maru/video-media
   DEPLOY_AGENT_HOST_GATEWAY=<agent_default gateway>
   ```

   The existing `threads` directory is already a bind mount to the second disk.
   Moving the public site-media root itself requires changing the web server's
   mount/alias too, so it intentionally remains separate from cache migration.

3. Set the same `DEPLOY_AGENT_URL=http://host.docker.internal:9899` and
   `DEPLOY_AGENT_TOKEN` in the backend `secrets.env`. The compose manifest maps
   `host.docker.internal` to `DEPLOY_AGENT_HOST_GATEWAY`; the agent is not public.

4. Install and start the service:

   ```text
   sudo install -d -o deploy -g deploy /var/lib/alexgetman-deploy
   sudo install -m 0644 deploy/alexgetman-deploy-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now alexgetman-deploy-agent
   ```

5. In GitHub repository settings set `DEPLOY_ENABLED=true` as an Actions variable
   and configure `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_PRIVATE_KEY`,
   `DEPLOY_SSH_KNOWN_HOSTS`, and `DEPLOY_AGENT_TOKEN` as Actions secrets.

Each deployment receives an immutable `ghcr.io/...@sha256:...` reference. CI builds
the image once, then updates `alex` and, when repository variable
`MARU_DEPLOY_ENABLED=true` is set, `maru`. The agent pulls/recreates only the
target's `backend`, waits for its own Docker health plus `/readyz`, and restores
that target's previous digest automatically on failure. A successful deployment
sends the controller bot a target-specific one-click rollback button. The callback
is accepted only from `CONTROLLER_ADMIN_IDS` and is rejected after a newer release
exists for that target.

## Read-only runtime diagnostics

The production image includes the bundled backend operations CLI, so status can be
inspected without a checkout on the host:

```text
docker exec alexgetman-backend bun /app/ops/cli.js status
docker exec alexgetman-backend bun /app/ops/cli.js doctor
docker exec alexgetman-backend bun /app/ops/cli.js audit
```

Use only the read-only commands above for routine diagnostics. Commands such as
`backup`, `restore`, and `metrics-backfill --apply` mutate state and require an
explicit maintenance task.
