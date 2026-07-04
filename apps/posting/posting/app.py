#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

import control_plane
import controller_bot
import pipeline_metrics
import telegram_to_threads
from posting_core.worker_runner import run_services


HEALTH_PATH = Path("/data/posting_app_health.json")
SERVICES = {
    "bridge": telegram_to_threads.main,
    "controller": controller_bot.main,
    "metrics": pipeline_metrics.daemon,
    "observability": lambda: control_plane.cmd_watch(type("Args", (), {})()),
}


def log(message: str) -> None:
    print(f"[posting-app] {message}", flush=True)


def main() -> int:
    return run_services(SERVICES, health_path=HEALTH_PATH, log=log)


if __name__ == "__main__":
    sys.exit(main())
