#!/usr/bin/env bash
set -euo pipefail
export HOME=/home/deploy

if command -v flock >/dev/null 2>&1; then
  exec 9>/tmp/ialexey-web-sync.lock
  flock -n 9 || exit 0
fi

REPO=/home/deploy/repos/ialexey-web
PUBLIC=/home/deploy/ialexey-web

cd "$REPO"
before=$(/usr/bin/git rev-parse HEAD)
/usr/bin/git fetch origin main --quiet
after=$(/usr/bin/git rev-parse origin/main)

# Detect if git pull is needed
if [ "$before" != "$after" ]; then
  echo "$(date -Iseconds) updating $before -> $after"
  /usr/bin/git pull --ff-only origin main
fi

# Ensure output directories exist
mkdir -p "$PUBLIC"

# Build and publish static output through the canonical Docker site-feed service.
cd /opt/alexgetman-posting
/usr/bin/docker compose exec -T site-feed python3 -m site_feed.cli render

# Sync cached habr images (not in dist/ since they're downloaded during build, after Astro copies public/)
mkdir -p "$PUBLIC"/habr-images
if [ -d "$REPO"/apps/web/public/habr-images ]; then
  /usr/bin/rsync -a "$REPO"/apps/web/public/habr-images/ "$PUBLIC"/habr-images/
fi

# Sync runtime media referenced by feed.json. The render step excludes media to avoid
# deleting files owned by the posting pipeline.
mkdir -p "$PUBLIC"/media
if [ -d "$REPO"/apps/web/public/media ]; then
  /usr/bin/rsync -a "$REPO"/apps/web/public/media/ "$PUBLIC"/media/
elif [ -d "$REPO"/media ]; then
  /usr/bin/rsync -a "$REPO"/media/ "$PUBLIC"/media/
fi

# 2. Sync bin scripts
mkdir -p "$PUBLIC"/bin
/usr/bin/rsync -a --delete "$REPO"/bin/ "$PUBLIC"/bin/
