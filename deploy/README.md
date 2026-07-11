# Production deployment agent

`deploy-agent.ts` is intentionally a small host-side Bun service. It is the only
component allowed to invoke Docker. The Astro application never mounts the Docker
socket and can only request a rollback using a private bearer-authenticated route.

## One-time host setup

1. Create a stable compose directory and copy the checked-in compose manifest plus
   existing `secrets.env` and `site-feed.env` into it:

   ```text
   /home/deploy/alexgetman-runtime/compose.yaml
   /home/deploy/alexgetman-runtime/secrets.env
   /home/deploy/alexgetman-runtime/site-feed.env
   /home/deploy/alexgetman-runtime/deploy-image.env
   ```

   `deploy-image.env` must initially contain the immutable image that is currently
   working, for example `BACKEND_IMAGE=ghcr.io/alexgetmancom/alexgetman-backend@sha256:...`.
   Never seed it with `latest`; rollback is deliberately refused without a digest.

2. Copy `deploy-agent.env.example` to `/etc/alexgetman/deploy-agent.env`, fill the
   token/chat values, and set mode `0600`. Set `DEPLOY_AGENT_HOST` to Docker's host
   gateway address (normally `172.17.0.1`).

3. Set the same `DEPLOY_AGENT_URL=http://host.docker.internal:9899` and
   `DEPLOY_AGENT_TOKEN` in the backend `secrets.env`. The compose manifest maps
   `host.docker.internal` to Docker's host gateway; the agent is not public.

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

Each deployment receives an immutable `ghcr.io/...@sha256:...` reference. The
agent pulls/recreates only `backend`, waits for Docker health plus `/readyz`, and
restores the previous digest automatically on failure. A successful deployment
sends the controller bot a one-click rollback button. The callback is accepted
only from `CONTROLLER_ADMIN_IDS` and is rejected after a newer release exists.
