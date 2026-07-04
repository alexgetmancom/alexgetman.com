from __future__ import annotations

import json
from typing import Any

from ..db import connect, ensure_pipeline_schema
from ..paths import PostingPaths, get_paths
from ..time_utils import now_iso

def load_worker_state(name: str, fallback: dict[str, Any] | None = None, paths: PostingPaths | None = None) -> dict[str, Any]:
    paths = paths or get_paths()
    if paths.pipeline_db.exists():
        with connect(paths.pipeline_db) as conn:
            ensure_pipeline_schema(conn)
            row = conn.execute("SELECT state_json FROM worker_state WHERE name=?", (name,)).fetchone()
            if row:
                return json.loads(row["state_json"])
    return fallback or {}


def save_worker_state(name: str, state: dict[str, Any], paths: PostingPaths | None = None) -> None:
    paths = paths or get_paths()
    now = now_iso()
    if paths.pipeline_db.exists():
        with connect(paths.pipeline_db) as conn:
            ensure_pipeline_schema(conn)
            conn.execute(
                """
                INSERT INTO worker_state(name, state_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at
                """,
                (name, json.dumps(state, ensure_ascii=False), now),
            )
            conn.commit()
