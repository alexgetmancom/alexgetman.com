[English](backups.md) · [Русский](backups.ru.md)

# Backups

Two things are worth keeping, and they are kept differently because they differ
by three orders of magnitude in size.

## The database, which arrives on its own

Every day, silently, the Studio sends a copy of its database to the same
Telegram chat you author from: posts, schedules, delivery state, analytics,
external ids. Nothing to set up — it is on unless you turn it off under
**Settings → Notifications → Database backup**.

It is a real snapshot taken with SQLite's own backup, never a file copy. A live
database has a write-ahead log beside it, and a plain copy of one is a corrupt
database that only announces itself when someone tries to restore it.

To restore, download the file from the chat and:

```bash
docker compose cp <downloaded>.db app:/data/restore.db
docker compose exec app bun /app/ops/cli.js restore --source /data/restore.db --force
docker compose restart app
```

## The media, which is yours to arrange

Media is not in that copy and cannot be: those files are far past what Telegram
accepts. They live in the `app-data` volume, under `/data`, and they are the
part that cannot be regenerated — the source images and videos of everything you
published.

Solo Publisher deliberately ships no backup integration for them. A credential
for object storage, a schedule and a retention policy would be a second thing to
configure and get wrong, and every host already has a tool for this. Point one at
the volume.

**To another machine**, which is the simplest thing that works:

```bash
docker run --rm -v solo-publisher_app-data:/data:ro -v ~/.ssh:/root/.ssh:ro \
  instrumentisto/rsync-ssh \
  rsync -a --delete /data/ backup@your-other-host:/srv/solo-publisher-media/
```

**To S3 or anything like it**, with [restic](https://restic.net/) so the copies
are incremental and verifiable:

```bash
docker run --rm -v solo-publisher_app-data:/data:ro \
  -e RESTIC_REPOSITORY=s3:s3.amazonaws.com/your-bucket \
  -e RESTIC_PASSWORD=... -e AWS_ACCESS_KEY_ID=... -e AWS_SECRET_ACCESS_KEY=... \
  restic/restic backup /data
```

Put either behind a cron entry on the host at whatever hour suits you. Both read
the volume while the Studio runs; media files are written once and never edited,
so a copy taken mid-write is at worst a file the next run picks up.

Check the volume name first — Compose prefixes it with the project directory:

```bash
docker volume ls | grep app-data
```

## What is not worth backing up

`caddy-data` holds TLS certificates, which Caddy obtains again by itself.
`bot-api-data` holds Telegram's local file cache. Losing either costs a restart,
not data.
