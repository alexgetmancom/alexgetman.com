from __future__ import annotations

import sqlite3
from pathlib import Path

from posting_core.schema import (
    ensure_capability_schema,
    ensure_control_plane_schema,
    ensure_controller_schema,
    ensure_metrics_schema,
    ensure_pipeline_schema,
    ensure_queue_schema,
    seed_platform_rules,
)
from posting_core.time_utils import now_iso


def connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


__all__ = [
    "connect",
    "ensure_capability_schema",
    "ensure_control_plane_schema",
    "ensure_controller_schema",
    "ensure_metrics_schema",
    "ensure_pipeline_schema",
    "ensure_queue_schema",
    "now_iso",
    "seed_platform_rules",
]
