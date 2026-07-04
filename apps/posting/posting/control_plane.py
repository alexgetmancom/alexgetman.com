#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import time

from posting_core.control.alerts import send_alerts
from posting_core.control.config import DB_PATH, OBSERVABILITY_INTERVAL_SECONDS, json_dumps, log
from posting_core.control.events import emit_event
from posting_core.db import connect as db_connect, ensure_pipeline_schema
from posting_core.control.service import backup_db, command_center_payload, sync_control_plane


def cmd_init(args):
    with db_connect(DB_PATH) as conn:
        ensure_pipeline_schema(conn)
        sync_control_plane(conn)
    print(f"initialized {DB_PATH}")


def cmd_sync(args):
    with db_connect(DB_PATH) as conn:
        ensure_pipeline_schema(conn)
        sync_control_plane(conn)
    print(f"synced {DB_PATH}")


def cmd_health(args):
    with db_connect(DB_PATH) as conn:
        ensure_pipeline_schema(conn)
        payload = command_center_payload(conn)
        health = {
            "updated_at": payload["updated_at"],
            "queue_items": len(payload["queue"]) if isinstance(payload["queue"], list) else 0,
            "warnings": len(payload["events"]),
            "credentials_missing": [row["target"] for row in payload["credentials"] if row["status"] != "ready"],
        }
    print(json_dumps(health))


def cmd_watch(args):
    log(f"control-plane watcher started, interval={OBSERVABILITY_INTERVAL_SECONDS}s")
    while True:
        try:
            with db_connect(DB_PATH) as conn:
                ensure_pipeline_schema(conn)
                sync_control_plane(conn)
                sent = send_alerts(conn)
            if sent:
                log(f"sent alerts: {sent}")
        except Exception as exc:
            log(f"control-plane watcher failed: {exc}")
        time.sleep(OBSERVABILITY_INTERVAL_SECONDS)


def cmd_event(args):
    with db_connect(DB_PATH) as conn:
        ensure_pipeline_schema(conn)
        emit_event(conn, args.post_key, args.type, args.message, severity=args.severity, target=args.target)
        conn.commit()
    print("event recorded")


def cmd_json(args):
    with db_connect(DB_PATH) as conn:
        ensure_pipeline_schema(conn)
        print(json.dumps(command_center_payload(conn), ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="AlexGetman posting control plane")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init").set_defaults(func=cmd_init)
    sub.add_parser("sync").set_defaults(func=cmd_sync)
    sub.add_parser("health").set_defaults(func=cmd_health)
    sub.add_parser("json").set_defaults(func=cmd_json)
    sub.add_parser("backup").set_defaults(func=backup_db)
    sub.add_parser("watch").set_defaults(func=cmd_watch)

    event = sub.add_parser("event")
    event.add_argument("--type", required=True)
    event.add_argument("--message", required=True)
    event.add_argument("--severity", default="info", choices=("debug", "info", "warn", "error"))
    event.add_argument("--post-key")
    event.add_argument("--target")
    event.set_defaults(func=cmd_event)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
