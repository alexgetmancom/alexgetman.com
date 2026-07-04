from __future__ import annotations

import json
from typing import Any

from .db import connect, ensure_pipeline_schema
from .ops_lookup import PublicationRef, resolve_publication_ref
from .paths import PostingPaths
from .time_utils import now_iso
from .targets import SOCIAL_TARGET_IDS


def _legacy_message_id(ref: PublicationRef) -> int:
    if ref.message_id is not None:
        return int(ref.message_id)
    if ref.post_id is not None:
        return -int(ref.post_id)
    return 0


class RepairRepository:
    def __init__(self, paths: PostingPaths):
        self.paths = paths

    def require_db(self) -> None:
        if not self.paths.pipeline_db.exists():
            raise ValueError(f"pipeline db missing: {self.paths.pipeline_db}")

    def record_action(self, action: str, message_id: int | None, target: str | None, status: str, actor_type: str, details: dict[str, Any] | None = None) -> None:
        if not self.paths.pipeline_db.exists():
            return
        now = now_iso()
        with connect(self.paths.pipeline_db) as conn:
            ensure_pipeline_schema(conn)
            conn.execute(
                """
                INSERT INTO ops_actions(actor_type, action, message_id, target, status, details_json, created_at, completed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (actor_type, action, message_id, target, status, json.dumps(details or {}, ensure_ascii=False), now, now if status in {"ok", "failed"} else None),
            )
            conn.commit()

    def post_key_for(self, message_id: int) -> str | None:
        if not self.paths.pipeline_db.exists():
            return None
        with connect(self.paths.pipeline_db) as conn:
            row = conn.execute("SELECT post_key FROM posts WHERE message_id=?", (message_id,)).fetchone()
            return row["post_key"] if row else None

    def resolve_ref(self, value: str | int) -> PublicationRef:
        self.require_db()
        with connect(self.paths.pipeline_db) as conn:
            ensure_pipeline_schema(conn)
            return resolve_publication_ref(conn, value)

    def source_item_for(self, conn, message_id: int) -> dict[str, Any] | None:
        ensure_pipeline_schema(conn)
        row = conn.execute("SELECT item_json FROM site_source_items WHERE message_id=?", (message_id,)).fetchone()
        if not row:
            return None
        item = json.loads(row["item_json"] or "{}")
        return item if isinstance(item, dict) else None

    def plan_for(self, conn, message_id: int) -> dict[str, Any]:
        ensure_pipeline_schema(conn)
        row = conn.execute("SELECT plan_json FROM publish_plans WHERE message_id=?", (message_id,)).fetchone()
        if not row:
            return {}
        plan = json.loads(row["plan_json"] or "{}")
        return plan if isinstance(plan, dict) else {}

    def save_plan(self, conn, message_id: int, plan: dict[str, Any], now: str) -> None:
        ensure_pipeline_schema(conn)
        conn.execute(
            """
            INSERT INTO publish_plans(message_id, plan_json, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(message_id) DO UPDATE SET plan_json=excluded.plan_json, updated_at=excluded.updated_at
            """,
            (message_id, json.dumps(plan, ensure_ascii=False), now, now),
        )

    def save_source_item(self, conn, message_id: int, item: dict[str, Any], now: str) -> None:
        ensure_pipeline_schema(conn)
        conn.execute(
            """
            INSERT INTO site_source_items(message_id, item_json, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(message_id) DO UPDATE SET item_json=excluded.item_json, updated_at=excluded.updated_at
            """,
            (message_id, json.dumps(item, ensure_ascii=False), now, now),
        )

    def enqueue_publish_jobs(self, message_id: int | None, targets: dict[str, bool], payload: dict[str, Any], post_id: int | None = None, post_key: str | None = None) -> None:
        if not self.paths.pipeline_db.exists():
            return
        now = now_iso()
        post_key = post_key or (self.post_key_for(message_id) if message_id is not None else None) or (f"post:{post_id}" if post_id else None)
        with connect(self.paths.pipeline_db) as conn:
            ensure_pipeline_schema(conn)
            for target, enabled in targets.items():
                if not enabled or target not in SOCIAL_TARGET_IDS:
                    continue
                conn.execute(
                    """
                    INSERT INTO publish_jobs(post_key, message_id, post_id, target, status, attempt_count, next_attempt_at, locked_by, locked_at, payload_json, last_error, created_at, updated_at, publish_at)
                    VALUES (?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, ?, NULL, ?, ?, ?)
                    ON CONFLICT(message_id, target, status) DO UPDATE SET
                        post_key=excluded.post_key,
                        post_id=excluded.post_id,
                        attempt_count=0,
                        next_attempt_at=excluded.next_attempt_at,
                        locked_by=NULL,
                        locked_at=NULL,
                        payload_json=excluded.payload_json,
                        last_error=NULL,
                        updated_at=excluded.updated_at,
                        publish_at=excluded.publish_at
                    """,
                    (post_key, message_id, post_id, target, now, json.dumps(payload, ensure_ascii=False), now, now, payload.get("publish_at")),
                )
            conn.commit()

    def reset_target_status(self, message_id: int, target: str | None) -> None:
        with connect(self.paths.pipeline_db) as conn:
            post = conn.execute("SELECT post_key FROM posts WHERE message_id=?", (message_id,)).fetchone()
            if post:
                if target:
                    conn.execute("UPDATE post_targets SET status='queued', error=NULL WHERE post_key=? AND target=?", (post["post_key"], target))
                else:
                    conn.execute("UPDATE post_targets SET status='queued', error=NULL WHERE post_key=?", (post["post_key"],))
            conn.commit()

    def load_source_and_plan(self, message_id: int) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        self.require_db()
        with connect(self.paths.pipeline_db) as conn:
            return self.source_item_for(conn, message_id), self.plan_for(conn, message_id)

    def requeue_existing_publication(self, ref: PublicationRef, target: str | None, now: str) -> dict[str, Any]:
        with connect(self.paths.pipeline_db) as conn:
            ensure_pipeline_schema(conn)
            target_filter = "AND target=?" if target else ""
            params: list[Any] = [ref.post_key]
            if target:
                params.append(target)
            rows = conn.execute(
                f"""
                SELECT * FROM publish_jobs
                WHERE post_key=? {target_filter}
                ORDER BY job_id
                """,
                tuple(params),
            ).fetchall()
            if not rows and target:
                existing_payload = conn.execute(
                    "SELECT payload_json FROM publish_jobs WHERE post_key=? ORDER BY updated_at DESC LIMIT 1",
                    (ref.post_key,),
                ).fetchone()
                payload = json.loads(existing_payload["payload_json"] or "{}") if existing_payload else {
                    "post_id": ref.post_id,
                    "telegram_message_id": ref.message_id,
                    "created_at": now,
                    "requeued_at": now,
                }
                conn.execute(
                    """
                    INSERT INTO publish_jobs(post_key, message_id, post_id, target, status, attempt_count, next_attempt_at, payload_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
                    """,
                    (ref.post_key, _legacy_message_id(ref), ref.post_id, target, now, json.dumps(payload, ensure_ascii=False), now, now),
                )
                rows = conn.execute("SELECT * FROM publish_jobs WHERE post_key=? AND target=?", (ref.post_key, target)).fetchall()
            if not rows:
                raise ValueError(f"no publish jobs found for {ref.input}")
            queued_targets = []
            for row in rows:
                queued_targets.append(row["target"])
                conn.execute(
                    """
                    UPDATE publish_jobs
                    SET status='queued', attempt_count=0, next_attempt_at=?, locked_by=NULL, locked_at=NULL,
                        last_error=NULL, updated_at=?, publish_at=COALESCE(publish_at, ?)
                    WHERE job_id=?
                    """,
                    (now, now, now, row["job_id"]),
                )
                conn.execute(
                    """
                    INSERT INTO post_targets(post_key, target, status, error, skipped, updated_at, raw_json)
                    VALUES (?, ?, 'queued', NULL, 0, ?, ?)
                    ON CONFLICT(post_key, target) DO UPDATE SET
                        status='queued', error=NULL, skipped=0, updated_at=excluded.updated_at, raw_json=excluded.raw_json
                    """,
                    (ref.post_key, row["target"], now, json.dumps({"job_id": row["job_id"], "requeued_at": now}, ensure_ascii=False)),
                )
                conn.execute(
                    """
                    INSERT INTO post_events(post_key, event_type, severity, target, message, details_json, created_at)
                    VALUES (?, 'publish.job.requeued', 'info', ?, ?, ?, ?)
                    """,
                    (ref.post_key, row["target"], f"Manual requeue for {ref.post_key}", json.dumps({"job_id": row["job_id"], "input": ref.input}, ensure_ascii=False), now),
                )
            conn.commit()
            return {"ok": True, "post_key": ref.post_key, "post_id": ref.post_id, "message_id": ref.message_id, "targets": queued_targets}

    def save_requeue_plan(self, message_id: int, plan: dict[str, Any], now: str) -> None:
        with connect(self.paths.pipeline_db) as conn:
            self.save_plan(conn, message_id, plan, now)
            conn.commit()

    def update_text_and_queue_site_job(self, message_id: int, text_ru: str | None, text_en: str | None, now: str):
        with connect(self.paths.pipeline_db) as conn:
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(posts)").fetchall()}
            select_columns = ["post_key"]
            select_columns.append("chat_id" if "chat_id" in columns else "NULL AS chat_id")
            select_columns.append("text" if "text" in columns else "NULL AS text")
            select_columns.append("text_en" if "text_en" in columns else "NULL AS text_en")
            select_columns.append("media_count" if "media_count" in columns else "0 AS media_count")
            post = conn.execute(f"SELECT {', '.join(select_columns)} FROM posts WHERE message_id=?", (message_id,)).fetchone()
            if not post:
                raise ValueError(f"post {message_id} not found")
            if text_ru and "text" in columns:
                conn.execute("UPDATE posts SET text=? WHERE message_id=?", (text_ru, message_id))
            if text_en and "text_en" in columns:
                conn.execute("UPDATE posts SET text_en=? WHERE message_id=?", (text_en, message_id))
            ensure_pipeline_schema(conn)
            plan = self.plan_for(conn, message_id)
            if text_en:
                plan["text_en"] = text_en
                plan["edited_at"] = now
                self.save_plan(conn, message_id, plan, now)
            source_item = self.source_item_for(conn, message_id)
            if source_item is not None:
                if text_ru:
                    source_item["text_ru"] = text_ru
                if text_en:
                    source_item["text_en"] = text_en
                source_item["updated_at"] = now
                self.save_source_item(conn, message_id, source_item, now)
            reason = "edit_en" if text_en and not text_ru else "edit_text"
            conn.execute(
                "INSERT INTO site_jobs(message_id, reason, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)",
                (message_id, reason, now, now),
            )
            conn.commit()
            return post

    def replace_en_media_and_queue_site_job(self, message_id: int, media_en: list[dict[str, str]] | None, now: str) -> None:
        with connect(self.paths.pipeline_db) as conn:
            plan = self.plan_for(conn, message_id)
            source_item = self.source_item_for(conn, message_id)
            if not plan and source_item is None:
                raise ValueError(f"message {message_id} not found")
            plan["media_en"] = media_en
            plan["edited_at"] = now
            self.save_plan(conn, message_id, plan, now)
            if source_item is not None:
                source_item["media_en"] = media_en
                source_item["updated_at"] = now
                self.save_source_item(conn, message_id, source_item, now)
            ensure_pipeline_schema(conn)
            conn.execute(
                "INSERT INTO site_jobs(message_id, reason, status, created_at, updated_at) VALUES (?, 'replace_en_media', 'queued', ?, ?)",
                (message_id, now, now),
            )
            conn.commit()
