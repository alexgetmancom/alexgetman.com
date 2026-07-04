from __future__ import annotations

import hashlib
import sqlite3
from dataclasses import dataclass
from typing import Callable

from posting_core.db import ensure_pipeline_schema, now_iso


MigrationFn = Callable[[sqlite3.Connection], None]


@dataclass(frozen=True)
class Migration:
    migration_id: str
    name: str
    fn: MigrationFn

    @property
    def checksum(self) -> str:
        return hashlib.sha256(f"{self.migration_id}:{self.name}".encode("utf-8")).hexdigest()


MIGRATIONS: tuple[Migration, ...] = (
    Migration("20260623_0001", "baseline unified pipeline schema", ensure_pipeline_schema),
    Migration("20260624_0002", "scheduled publishing fields", ensure_pipeline_schema),
    Migration("20260625_0003", "independent scheduling metadata", ensure_pipeline_schema),
    Migration("20260625_0004", "canonical publications and locale records", ensure_pipeline_schema),
)


EXPECTED_SCHEMA: dict[str, tuple[str, ...]] = {
    "schema_migrations": ("migration_id", "name", "checksum", "applied_at"),
    "posts": ("post_key", "post_id", "message_id", "channel", "created_at", "updated_at"),
    "post_targets": ("post_key", "target", "status", "updated_at"),
    "post_metrics": ("post_key", "target", "metric_name", "value"),
    "metric_schedule": ("post_key", "target", "next_check_at"),
    "publish_jobs": ("job_id", "post_id", "message_id", "target", "status", "attempt_count", "publish_at", "next_attempt_at"),
    "publish_plans": ("message_id", "plan_json"),
    "site_source_items": ("message_id", "item_json"),
    "site_jobs": ("job_id", "post_id", "message_id", "reason", "status", "attempt_count", "next_attempt_at"),
    "publications": ("post_id", "draft_id", "status", "telegram_message_id"),
    "post_locales": ("post_id", "locale", "slug", "text", "html", "site_enabled"),
    "publication_plans": ("post_id", "plan_json"),
    "publication_sources": ("post_id", "item_json"),
    "worker_state": ("name", "state_json"),
    "ops_actions": ("action_id", "actor_type", "action", "status"),
    "post_events": ("id", "event_type", "severity", "message", "created_at"),
    "drafts": (
        "id",
        "admin_id",
        "status",
        "text_ru",
        "targets_json",
        "scheduled_at",
        "scheduled_en_at",
        "publish_mode",
        "post_id",
        "text_ru_entities_json",
        "text_en_entities_json",
    ),
    "admin_state": ("admin_id", "action", "draft_id"),
    "pending_albums": ("id", "admin_id", "chat_id", "media_group_id"),
    "post_lifecycle": ("post_key", "state", "updated_at"),
    "alert_dedup": ("alert_key", "last_sent_at", "suppressed_count"),
    "media_assets": ("asset_key", "post_key", "locale", "role", "status"),
    "platform_rules": ("target", "format_key", "support_status"),
    "credential_checks": ("target", "status", "required_env_json", "missing_env_json"),
    "content_memory": ("post_key", "message_id", "lang", "updated_at"),
    "analytics_rollups": ("rollup_key", "scope", "subject", "metric_json"),
    "deployment_snapshots": ("id", "action", "status", "created_at"),
    "media_test_cases": ("test_id", "format_key", "title", "status"),
    "media_test_results": ("test_id", "target", "message_id", "status"),
    "platform_capabilities": ("target", "format_key", "status"),
}


def ensure_migration_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            migration_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )
        """
    )
    conn.commit()


def applied_migrations(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    ensure_migration_schema(conn)
    return {
        row["migration_id"]: row
        for row in conn.execute("SELECT migration_id, name, checksum, applied_at FROM schema_migrations").fetchall()
    }


def migration_status(conn: sqlite3.Connection) -> list[dict[str, str | bool | None]]:
    applied = applied_migrations(conn)
    status = []
    for migration in MIGRATIONS:
        row = applied.get(migration.migration_id)
        status.append(
            {
                "migration_id": migration.migration_id,
                "name": migration.name,
                "checksum": migration.checksum,
                "applied": row is not None,
                "applied_at": row["applied_at"] if row else None,
                "checksum_ok": (row is None or row["checksum"] == migration.checksum),
            }
        )
    return status


def apply_migrations(conn: sqlite3.Connection) -> list[dict[str, str]]:
    applied = applied_migrations(conn)
    completed = []
    for migration in MIGRATIONS:
        row = applied.get(migration.migration_id)
        if row:
            if row["checksum"] != migration.checksum:
                raise RuntimeError(f"migration checksum mismatch: {migration.migration_id}")
            continue
        migration.fn(conn)
        ensure_migration_schema(conn)
        applied_at = now_iso()
        conn.execute(
            """
            INSERT INTO schema_migrations(migration_id, name, checksum, applied_at)
            VALUES (?, ?, ?, ?)
            """,
            (migration.migration_id, migration.name, migration.checksum, applied_at),
        )
        conn.commit()
        completed.append({"migration_id": migration.migration_id, "name": migration.name, "applied_at": applied_at})
    return completed


def verify_schema(conn: sqlite3.Connection) -> list[str]:
    errors: list[str] = []
    tables = {
        row["name"]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    for table, columns in EXPECTED_SCHEMA.items():
        if table not in tables:
            errors.append(f"missing table: {table}")
            continue
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for column in columns:
            if column not in existing:
                errors.append(f"missing column: {table}.{column}")
    for row in migration_status(conn):
        if row["applied"] and not row["checksum_ok"]:
            errors.append(f"migration checksum mismatch: {row['migration_id']}")
    return errors
