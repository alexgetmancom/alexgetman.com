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
  
  # Check if npm dependencies changed
  if ! /usr/bin/git diff --quiet "$before" "$after" -- package.json package-lock.json; then
    echo "package.json changed, running npm install..."
    npm install
  fi
  
  # Build Astro
  echo "Building Astro static files..."
  npm run build
fi

# Ensure output directories exist
mkdir -p "$PUBLIC"

# 1. Sync compiled static site, excluding dynamic media files and tracking stats
/usr/bin/rsync -a --delete --exclude "media" --exclude "stats" "$REPO"/dist/ "$PUBLIC"/

# 1a. Sync cached habr images (not in dist/ since they're downloaded during build, after Astro copies public/)
mkdir -p "$PUBLIC"/habr-images
if [ -d "$REPO"/apps/web/public/habr-images ]; then
  /usr/bin/rsync -a "$REPO"/apps/web/public/habr-images/ "$PUBLIC"/habr-images/
fi

# 1b. Sync runtime media referenced by feed.json. dist sync excludes media to avoid
# deleting files owned by the posting pipeline, so copy them explicitly.
mkdir -p "$PUBLIC"/media
if [ -d "$REPO"/apps/web/public/media ]; then
  /usr/bin/rsync -a "$REPO"/apps/web/public/media/ "$PUBLIC"/media/
elif [ -d "$REPO"/media ]; then
  /usr/bin/rsync -a "$REPO"/media/ "$PUBLIC"/media/
fi

# 2. Sync Python feed scripts to public directory
mkdir -p "$PUBLIC"/feed
/usr/bin/rsync -a --delete "$REPO"/apps/web/feed/ "$PUBLIC"/feed/

# 3. Sync bin scripts
mkdir -p "$PUBLIC"/bin
/usr/bin/rsync -a --delete "$REPO"/bin/ "$PUBLIC"/bin/

# Run collector render if available (prefer new repository-managed path, fallback to old path)
if [ -x "$PUBLIC"/feed/collector.py ] && [ -f /home/deploy/ialexey-feed/ialexey-feed.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /home/deploy/ialexey-feed/ialexey-feed.env
  set +a
  /usr/bin/python3 "$PUBLIC"/feed/collector.py render
elif [ -x /home/deploy/ialexey-feed/collector.py ] && [ -f /home/deploy/ialexey-feed/ialexey-feed.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /home/deploy/ialexey-feed/ialexey-feed.env
  set +a
  /usr/bin/python3 /home/deploy/ialexey-feed/collector.py render
fi
