from __future__ import annotations

import json
from typing import Any

from .jobs import _post_key_for, claim_due_publish_jobs, complete_publish_job, fail_publish_job, worker_id
from .state import load_worker_state, save_worker_state
from ..db import connect, ensure_pipeline_schema
from ..paths import PostingPaths, get_paths
from ..targets import ALL_TARGET_IDS, SOCIAL_TARGET_IDS
from ..time_utils import now_iso

__all__ = [
    "cancel_publication_jobs",
    "claim_due_publish_jobs",
    "complete_publish_job",
    "enqueue_publication",
    "enqueue_publish_message",
    "fail_publish_job",
    "load_worker_state",
    "save_worker_state",
    "worker_id",
]

def _enabled_targets(plan: dict[str, Any], fallback: dict[str, Any] | None = None) -> dict[str, bool]:
    raw = plan.get("targets") if isinstance(plan.get("targets"), dict) else (fallback or {})
    return {target: bool(raw.get(target)) for target in ALL_TARGET_IDS if raw.get(target)}


def _json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False)


def _upsert_json_row(conn, table: str, key_name: str, key_value: int, json_column: str, value: dict[str, Any], now: str) -> None:
    conn.execute(
        f"""
        INSERT INTO {table}({key_name}, {json_column}, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT({key_name}) DO UPDATE SET
            {json_column}=excluded.{json_column},
            updated_at=excluded.updated_at
        """,
        (key_value, _json(value), now, now),
    )


def _insert_site_job(
    conn,
    *,
    message_id: int,
    now: str,
    reason: str,
    post_id: int | None = None,
    next_attempt_at: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO site_jobs(post_id, message_id, reason, status, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', ?, ?, ?)
        """,
        (post_id, message_id, reason, next_attempt_at, now, now),
    )


def _enqueue_legacy_publish_job(conn, post_key: str, message_id: int, target: str, job: dict[str, Any], publish_at: str | None, now: str) -> None:
    conn.execute(
        """
        INSERT INTO publish_jobs(post_key, message_id, target, status, publish_at, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
        ON CONFLICT(message_id, target, status) DO UPDATE SET
            publish_at=excluded.publish_at,
            payload_json=excluded.payload_json,
            updated_at=excluded.updated_at
        """,
        (post_key, message_id, target, publish_at, _json(job), now, now),
    )


def _enqueue_publication_publish_job(
    conn,
    *,
    post_key: str,
    post_id: int,
    message_id: int,
    target: str,
    job: dict[str, Any],
    publish_at: str | None,
    now: str,
) -> None:
    existing = conn.execute(
        """
        SELECT job_id
        FROM publish_jobs
        WHERE post_id=? AND target=? AND status IN ('queued', 'publishing', 'published', 'skipped')
        ORDER BY job_id DESC
        LIMIT 1
        """,
        (post_id, target),
    ).fetchone()
    if existing:
        conn.execute(
            """
            UPDATE publish_jobs
            SET publish_at=?, payload_json=?, updated_at=?
            WHERE job_id=? AND status='queued'
            """,
            (publish_at, _json(job), now, existing["job_id"]),
        )
        return
    conn.execute(
        """
        INSERT INTO publish_jobs(
            post_key, post_id, message_id, target, status, publish_at,
            payload_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)
        """,
        (post_key, post_id, message_id, target, publish_at, _json(job), now, now),
    )


def enqueue_publish_message(
    message_id: int,
    plan: dict[str, Any],
    job: dict[str, Any],
    source_item: dict[str, Any] | None = None,
    paths: PostingPaths | None = None,
    publish_at_by_target: dict[str, str | None] | None = None,
    enqueue_targets: dict[str, bool] | None = None,
) -> None:
    paths = paths or get_paths()
    message_id = int(message_id)
    now = now_iso()
    publish_at_by_target = publish_at_by_target or {}
    if paths.pipeline_db.exists():
        with connect(paths.pipeline_db) as conn:
            ensure_pipeline_schema(conn)
            post_key = _post_key_for(conn, message_id)
            _upsert_json_row(conn, "publish_plans", "message_id", message_id, "plan_json", plan, now)
            if source_item is not None:
                _upsert_json_row(conn, "site_source_items", "message_id", message_id, "item_json", source_item, now)
                _insert_site_job(conn, message_id=message_id, reason="publish", now=now)
                site_en_at = publish_at_by_target.get("site_en")
                if site_en_at:
                    _insert_site_job(conn, message_id=message_id, reason="publish_en", next_attempt_at=site_en_at, now=now)
            targets = (
                enqueue_targets
                if enqueue_targets is not None
                else _enabled_targets(
                    plan,
                    source_item.get("targets") if isinstance(source_item, dict) else None,
                )
            )
            if enqueue_targets is None and not targets:
                targets = {target: True for target in ALL_TARGET_IDS}
            for target, enabled in targets.items():
                if not enabled or target not in SOCIAL_TARGET_IDS:
                    continue
                _enqueue_legacy_publish_job(conn, post_key, message_id, target, job, publish_at_by_target.get(target), now)
            conn.commit()


def enqueue_publication(
    post_id: int,
    plan: dict[str, Any],
    job: dict[str, Any],
    source_item: dict[str, Any] | None = None,
    paths: PostingPaths | None = None,
    publish_at_by_target: dict[str, str | None] | None = None,
    enqueue_targets: dict[str, bool] | None = None,
) -> None:
    paths = paths or get_paths()
    post_id = int(post_id)
    now = now_iso()
    publish_at_by_target = publish_at_by_target or {}
    legacy_message_id = int(job.get("telegram_message_id") or -post_id)
    with connect(paths.pipeline_db) as conn:
        ensure_pipeline_schema(conn)
        post_key = f"post:{post_id}"
        _upsert_json_row(conn, "publication_plans", "post_id", post_id, "plan_json", plan, now)
        if source_item is not None:
            _upsert_json_row(conn, "publication_sources", "post_id", post_id, "item_json", source_item, now)
            for target, locale in (("site_ru", "ru"), ("site_en", "en")):
                if not plan.get("targets", {}).get(target):
                    continue
                _insert_site_job(
                    conn,
                    post_id=post_id,
                    message_id=legacy_message_id,
                    reason=f"publish_{locale}",
                    next_attempt_at=publish_at_by_target.get(target),
                    now=now,
                )
        targets = enqueue_targets if enqueue_targets is not None else _enabled_targets(plan)
        for target, enabled in targets.items():
            if not enabled or target not in SOCIAL_TARGET_IDS:
                continue
            _enqueue_publication_publish_job(
                conn,
                post_key=post_key,
                post_id=post_id,
                message_id=legacy_message_id,
                target=target,
                job=job,
                publish_at=publish_at_by_target.get(target),
                now=now,
            )
        conn.commit()


def migrate_scheduled_message(
    temporary_message_id: int,
    message_id: int,
    job_payload: dict[str, Any],
    plan: dict[str, Any],
    paths: PostingPaths | None = None,
) -> set[str]:
    paths = paths or get_paths()
    if not paths.pipeline_db.exists():
        return set()
    temporary_message_id = int(temporary_message_id)
    message_id = int(message_id)
    now = now_iso()
    migrated_targets: set[str] = set()
    with connect(paths.pipeline_db) as conn:
        ensure_pipeline_schema(conn)
        temporary_key = _post_key_for(conn, temporary_message_id)
        real_key = _post_key_for(conn, message_id)
        target_rows = conn.execute(
            "SELECT * FROM post_targets WHERE post_key=?",
            (temporary_key,),
        ).fetchall()
        for row in target_rows:
            migrated_targets.add(row["target"])
            conn.execute(
                """
                INSERT INTO post_targets(
                    post_key, target, status, external_id, external_ids_json, url,
                    error, skipped, published_at, updated_at, raw_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(post_key, target) DO UPDATE SET
                    status=excluded.status,
                    external_id=CASE WHEN excluded.status='published' THEN excluded.external_id ELSE NULL END,
                    external_ids_json=CASE WHEN excluded.status='published' THEN excluded.external_ids_json ELSE NULL END,
                    url=CASE WHEN excluded.status='published' THEN excluded.url ELSE NULL END,
                    error=excluded.error,
                    skipped=excluded.skipped,
                    published_at=COALESCE(excluded.published_at, post_targets.published_at),
                    updated_at=excluded.updated_at,
                    raw_json=excluded.raw_json
                """,
                (
                    real_key,
                    row["target"],
                    row["status"],
                    row["external_id"],
                    row["external_ids_json"],
                    row["url"],
                    row["error"],
                    row["skipped"],
                    row["published_at"],
                    now,
                    row["raw_json"],
                ),
            )
        conn.execute("DELETE FROM post_targets WHERE post_key=?", (temporary_key,))

        jobs = conn.execute(
            "SELECT job_id, target FROM publish_jobs WHERE message_id=?",
            (temporary_message_id,),
        ).fetchall()
        payload_json = json.dumps(job_payload, ensure_ascii=False)
        for row in jobs:
            migrated_targets.add(row["target"])
            conn.execute(
                """
                UPDATE publish_jobs
                SET post_key=?, message_id=?, payload_json=?, updated_at=?
                WHERE job_id=?
                """,
                (real_key, message_id, payload_json, now, row["job_id"]),
            )
        conn.execute(
            """
            INSERT INTO publish_plans(message_id, plan_json, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(message_id) DO UPDATE SET
                plan_json=excluded.plan_json,
                updated_at=excluded.updated_at
            """,
            (message_id, json.dumps(plan, ensure_ascii=False), now, now),
        )
        conn.execute("DELETE FROM publish_plans WHERE message_id=?", (temporary_message_id,))
        conn.commit()
    return migrated_targets


def cancel_scheduled_message(
    temporary_message_id: int,
    paths: PostingPaths | None = None,
) -> set[str]:
    paths = paths or get_paths()
    if not paths.pipeline_db.exists():
        return set()
    with connect(paths.pipeline_db) as conn:
        ensure_pipeline_schema(conn)
        temporary_key = _post_key_for(conn, int(temporary_message_id))
        final_targets = {
            row["target"]
            for row in conn.execute(
                """
                SELECT target
                FROM publish_jobs
                WHERE message_id=? AND status IN ('publishing', 'published', 'skipped')
                """,
                (int(temporary_message_id),),
            ).fetchall()
        }
        conn.execute(
            "DELETE FROM publish_jobs WHERE message_id=? AND status IN ('queued', 'failed')",
            (int(temporary_message_id),),
        )
        remaining = conn.execute(
            "SELECT 1 FROM publish_jobs WHERE message_id=? LIMIT 1",
            (int(temporary_message_id),),
        ).fetchone()
        if not remaining:
            conn.execute("DELETE FROM publish_plans WHERE message_id=?", (int(temporary_message_id),))
            conn.execute(
                "DELETE FROM post_targets WHERE post_key=? AND status NOT IN ('published', 'skipped')",
                (temporary_key,),
            )
        conn.commit()
        return final_targets


def load_publish_plan(message_id: int, paths: PostingPaths | None = None) -> dict[str, Any]:
    paths = paths or get_paths()
    message_id = int(message_id)
    if paths.pipeline_db.exists():
        with connect(paths.pipeline_db) as conn:
            ensure_pipeline_schema(conn)
            row = conn.execute("SELECT plan_json FROM publish_plans WHERE message_id=?", (message_id,)).fetchone()
            if row:
                return json.loads(row["plan_json"])
    return {}


def load_publication_plan(post_id: int, paths: PostingPaths | None = None) -> dict[str, Any]:
    paths = paths or get_paths()
    with connect(paths.pipeline_db) as conn:
        ensure_pipeline_schema(conn)
        row = conn.execute(
            "SELECT plan_json FROM publication_plans WHERE post_id=?",
            (int(post_id),),
        ).fetchone()
        return json.loads(row["plan_json"]) if row else {}


def cancel_publication_jobs(post_id: int, paths: PostingPaths | None = None) -> set[str]:
    paths = paths or get_paths()
    with connect(paths.pipeline_db) as conn:
        ensure_pipeline_schema(conn)
        final_targets = {
            row["target"]
            for row in conn.execute(
                """
                SELECT target FROM publish_jobs
                WHERE post_id=? AND status IN ('publishing', 'published', 'skipped')
                """,
                (int(post_id),),
            ).fetchall()
        }
        conn.execute(
            "DELETE FROM publish_jobs WHERE post_id=? AND status IN ('queued', 'failed')",
            (int(post_id),),
        )
        conn.execute(
            "DELETE FROM site_jobs WHERE post_id=? AND status IN ('queued', 'failed')",
            (int(post_id),),
        )
        conn.commit()
        return final_targets
