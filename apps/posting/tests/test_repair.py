import json
import sqlite3

import pytest

from posting_core.db import ensure_pipeline_schema
from posting_core.paths import PostingPaths
from posting_core.repair import RepairService, parse_media


@pytest.fixture
def paths(tmp_path):
    result = PostingPaths(
        data_dir=tmp_path,
        pipeline_db=tmp_path / "pipeline.db",
        controller_db=tmp_path / "controller.db",
    )
    with sqlite3.connect(result.pipeline_db) as conn:
        conn.row_factory = sqlite3.Row
        ensure_pipeline_schema(conn)
        conn.execute(
            """
            INSERT INTO posts(post_key, channel, message_id, text_en, status, created_at, updated_at)
            VALUES('telegram:alexgetmancom:999', 'alexgetmancom', 999, 'old', 'active', 'now', 'now')
            """
        )
        conn.execute(
            """
            INSERT INTO post_targets(post_key, target, status, error, updated_at)
            VALUES('telegram:alexgetmancom:999', 'linkedin', 'failed', 'old error', 'now')
            """
        )
        source_item = {
            "draft_id": 1,
            "chat_id": "-100",
            "text_ru": "ru",
            "text_en": "en",
            "media_ru": [{"type": "photo", "file_id": "ru-file"}],
            "targets": {"linkedin": True, "site_en": True},
        }
        plan = {"targets": {"linkedin": True, "site_en": True}, "text_en": "en"}
        conn.execute(
            "INSERT INTO site_source_items(message_id, item_json, created_at, updated_at) VALUES(999, ?, 'now', 'now')",
            (json.dumps(source_item, ensure_ascii=False),),
        )
        conn.execute(
            "INSERT INTO publish_plans(message_id, plan_json, created_at, updated_at) VALUES(999, ?, 'now', 'now')",
            (json.dumps(plan, ensure_ascii=False),),
        )
    return result


def test_requeue_writes_durable_job(paths):
    result = RepairService(paths, actor_type="test").requeue(999, target="linkedin")
    assert result["ok"]

    with sqlite3.connect(paths.pipeline_db) as conn:
        rows = conn.execute("SELECT message_id, target, status, payload_json FROM publish_jobs").fetchall()
        target_status = conn.execute("SELECT status, error FROM post_targets WHERE target='linkedin'").fetchone()
        plan = conn.execute("SELECT plan_json FROM publish_plans WHERE message_id=999").fetchone()[0]

    assert [(row[0], row[1], row[2]) for row in rows] == [(999, "linkedin", "queued")]
    assert json.loads(rows[0][3])["requeue_target"] == "linkedin"
    assert json.loads(plan)["targets"]["linkedin"]
    assert target_status == ("queued", None)


def test_requeue_canonical_post_id_without_site_source(paths):
    with sqlite3.connect(paths.pipeline_db) as conn:
        conn.execute(
            """
            INSERT INTO publish_jobs(post_key, message_id, post_id, target, status, payload_json, created_at, updated_at)
            VALUES('post:19', 453, 19, 'bluesky', 'published', ?, 'old', 'old')
            """,
            (json.dumps({"post_id": 19, "text_en": "EN"}, ensure_ascii=False),),
        )
        conn.execute(
            """
            INSERT INTO post_targets(post_key, target, status, external_id, error, updated_at)
            VALUES('post:19', 'bluesky', 'published', 'at://did/app.bsky.feed.post/abc', NULL, 'old')
            """
        )
        conn.commit()

    result = RepairService(paths, actor_type="test").requeue(19, target="bluesky")

    assert result["ok"]
    assert result["post_key"] == "post:19"
    with sqlite3.connect(paths.pipeline_db) as conn:
        job = conn.execute(
            "SELECT status, attempt_count, last_error FROM publish_jobs WHERE post_key='post:19' AND target='bluesky'"
        ).fetchone()
        target = conn.execute(
            "SELECT status, error FROM post_targets WHERE post_key='post:19' AND target='bluesky'"
        ).fetchone()
    assert job == ("queued", 0, None)
    assert target == ("queued", None)


def test_edit_en_updates_db_and_site_job(paths):
    result = RepairService(paths, actor_type="test").edit_en(999, "new en")
    assert result["ok"]

    with sqlite3.connect(paths.pipeline_db) as conn:
        text_en = conn.execute("SELECT text_en FROM posts WHERE message_id=999").fetchone()[0]
        source = json.loads(conn.execute("SELECT item_json FROM site_source_items WHERE message_id=999").fetchone()[0])
        jobs = conn.execute("SELECT message_id, reason, status FROM site_jobs").fetchall()

    assert text_en == "new en"
    assert source["text_en"] == "new en"
    assert jobs == [(999, "edit_en", "queued")]


def test_parse_media_normalizes_items():
    assert parse_media('[{"type":"IMAGE","file_id":"abc"}]') == [{"type": "photo", "file_id": "abc"}]
    assert parse_media("fallback") is None
