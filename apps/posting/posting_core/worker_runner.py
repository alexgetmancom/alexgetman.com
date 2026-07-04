from __future__ import annotations

import json
import signal
import threading
import time
import traceback
from collections.abc import Callable, Mapping
from pathlib import Path


ServiceMap = Mapping[str, Callable[[], None]]


def run_services(
    services: ServiceMap,
    *,
    health_path: Path,
    log: Callable[[str], None],
    health_interval_seconds: int = 5,
) -> int:
    stopping = threading.Event()
    status: dict[str, dict[str, str | float | int | None]] = {}

    def write_health() -> None:
        try:
            health_path.parent.mkdir(parents=True, exist_ok=True)
            health_path.write_text(
                json.dumps({"updated_at": time.time(), "services": status}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            log(f"health write failed: {exc}")

    def run_service(name: str, target: Callable[[], None]) -> None:
        status[name] = {"state": "starting", "started_at": time.time(), "last_error": None, "stopped_at": None}
        write_health()
        try:
            log(f"starting {name}")
            status[name]["state"] = "running"
            write_health()
            target()
            status[name]["state"] = "stopped"
            status[name]["stopped_at"] = time.time()
        except SystemExit as exc:
            status[name]["state"] = "exited"
            status[name]["last_error"] = str(exc)
            status[name]["stopped_at"] = time.time()
            log(f"{name} exited: {exc}")
        except Exception as exc:
            status[name]["state"] = "failed"
            status[name]["last_error"] = "".join(traceback.format_exception_only(type(exc), exc)).strip()
            status[name]["stopped_at"] = time.time()
            log(f"{name} failed: {exc}")
            traceback.print_exc()
        finally:
            write_health()

    def stop(signum=None, frame=None) -> None:
        stopping.set()
        log("stopping")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    threads = []
    for name, target in services.items():
        thread = threading.Thread(target=run_service, args=(name, target), name=name, daemon=True)
        thread.start()
        threads.append(thread)

    while not stopping.is_set():
        write_health()
        failed = [name for name, service_status in status.items() if service_status.get("state") in {"failed", "exited", "stopped"}]
        if failed:
            log(f"service stopped unexpectedly: {', '.join(failed)}")
            return 1
        stopping.wait(health_interval_seconds)
    write_health()
    return 0
