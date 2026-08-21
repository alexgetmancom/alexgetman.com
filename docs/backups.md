[English](backups.md) · [Русский](backups.ru.md)

# Backups

Two things are worth keeping, and they are kept differently because they differ
by three orders of magnitude in size.

## The database, which arrives on its own

When Telegram is configured, the Studio silently sends a daily copy of its
database to the same chat you author from: posts, schedules, delivery state,
analytics and external ids. It is on unless you turn it off under **Settings →
Notifications → Database backup**. An MCP-only or site-only Studio has no chat
to deliver that copy to, so back up its `app-data` volume directly.

It is a real snapshot taken with SQLite's own backup, never a file copy. A live
database has a write-ahead log beside it, and a plain copy of one is a corrupt
database that only announces itself when someone tries to restore it.

To restore, download the file from the chat and:

```bash
docker compose cp <downloaded>.db app:/data/restore.db
docker compose exec app bun /app/ops/cli.js restore --source /data/restore.db --force
docker compose restart app
```

## The media, which has its own command

Media is not in that copy and cannot be: those files are far past what Telegram
accepts. They live on the data volume — video, posters, story cards and the
published site's assets — and they are the part that cannot be regenerated.

`backup-media` archives them:

```bash
docker compose exec app bun /app/ops/cli.js backup-media
```

It writes one gzipped tar into `BACKUP_DIR`, which `BACKUP_DIR_HOST` in `.env`
points at. That location must not be the data volume, and the command refuses if
it is: a copy that dies with the disk it is copying is not a backup. Paths inside
the archive are relative to the volume root, so it restores onto a fresh volume
unchanged:

```bash
tar -xzf media-<stamp>.tar.gz -C /data
```

`doctor` reports the deployment unhealthy while the newest archive is missing or
more than a week old, so a forgotten backup is noticed while the volume it
protects is still intact:

```bash
docker compose exec app bun /app/ops/cli.js doctor
```

Put the command behind a cron entry on the host at whatever hour suits you. It
reads the volume while the Studio runs; media files are written once and never
edited, so a copy taken mid-write is at worst a file the next run picks up.

Where `BACKUP_DIR_HOST` itself should point is the one part still yours to
choose — another disk, a mount, a machine that is not this one. Solo Publisher
ships no object-storage integration on purpose: a credential, a schedule and a
retention policy would be a second thing to configure and get wrong, and every
host already has a tool for moving a directory somewhere else.

## What is not worth backing up

`caddy-data` holds TLS certificates, which Caddy obtains again by itself.
`bot-api-data` holds Telegram's local file cache. Losing either costs a restart,
not data.
