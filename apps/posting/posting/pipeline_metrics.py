#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import time

from posting_core.metrics_config import DB_PATH, REFRESH_INTERVAL_SECONDS, log
from posting_core.metrics.feed import sync_feed
from posting_core.metrics.facebook import sync_facebook_metrics
from posting_core.metrics.maintenance import active_maintenance_lock
from posting_core.metrics.repository import connect
from posting_core.metrics.schedule import due_metric_tasks, ensure_metric_schedule
from posting_core.metrics.site import sync_site_metrics
from posting_core.metrics.social import sync_other_social_metrics
from posting_core.metrics.telegram import sync_telegram_metrics
from posting_core.metrics.threads import sync_threads_metrics
from posting_core.control.service import sync_control_plane


def sync_once():
    with connect() as conn:
        lock = active_maintenance_lock(conn)
        if lock and os.environ.get("METRICS_IGNORE_MAINTENANCE_LOCK") != "1":
            log(f"metrics sync skipped, maintenance lock held by {lock['owner']}")
            return
        count = sync_feed(conn)
        sync_site_metrics(conn)
        ensure_metric_schedule(conn)
        tasks = due_metric_tasks(conn)
        sync_telegram_metrics(conn, tasks)
        sync_threads_metrics(conn, tasks)
        sync_facebook_metrics(conn, tasks)
        sync_other_social_metrics(conn, tasks)
        sync_control_plane(conn)
    log(f"metrics sync complete, posts={count}, due_tasks={len(tasks)}, db={DB_PATH}")


def daemon():
    log(f"pipeline metrics worker started, interval={REFRESH_INTERVAL_SECONDS}s")
    while True:
        try:
            sync_once()
        except Exception as exc:
            log(f"metrics sync failed: {exc}")
        time.sleep(REFRESH_INTERVAL_SECONDS)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", nargs="?", default="once", choices=("once", "daemon"))
    args = parser.parse_args()
    if args.mode == "daemon":
        daemon()
    else:
        sync_once()


if __name__ == "__main__":
    main()
