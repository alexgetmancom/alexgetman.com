import json
import sqlite3
from urllib.error import HTTPError

import pytest

from posting_core.db import ensure_pipeline_schema
from posting_core.queue.errors import normalize_publish_result
from posting_core.paths import PostingPaths
from posting_core.queue import (
    claim_due_publish_jobs,
    complete_publish_job,
    enqueue_publish_message,
    enqueue_publication,
    fail_publish_job,
    migrate_scheduled_message,
)


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
            INSERT INTO posts(post_key, channel, message_id, status, created_at, updated_at)
            VALUES('telegram:alexgetmancom:999', 'alexgetmancom', 999, 'active', 'now', 'now')
            """
        )
    return result


def enqueue(paths, targets=None):
    selected_targets = targets or {"linkedin": True}
    enqueue_publish_message(
        999,
        {"targets": selected_targets},
        {"message_id": 999, "text_ru": "ru", "media_ru": None},
        {"message_id": 999, "text_ru": "ru", "targets": selected_targets},
        paths,
    )


def test_claim_is_atomic(paths):
    enqueue(paths)
    first = claim_due_publish_jobs(worker="w1", paths=paths)
    second = claim_due_publish_jobs(worker="w2", paths=paths)

    assert len(first) == 1
    assert second == []
    with sqlite3.connect(paths.pipeline_db) as conn:
        row = conn.execute("SELECT status, locked_by FROM publish_jobs").fetchone()
    assert row == ("publishing", "w1")


def test_complete_writes_target_and_event(paths):
    enqueue(paths)
    job = claim_due_publish_jobs(worker="w1", paths=paths)[0]
    complete_publish_job(job["job_id"], {"ok": True, "id": "li-1"}, paths)

    with sqlite3.connect(paths.pipeline_db) as conn:
        target = conn.execute("SELECT status, external_id, error FROM post_targets WHERE target='linkedin'").fetchone()
        job_row = conn.execute(
            "SELECT status, last_error FROM publish_jobs WHERE job_id=?", (job["job_id"],)
        ).fetchone()
        events = conn.execute("SELECT event_type FROM post_events ORDER BY id").fetchall()

    assert target == ("published", "li-1", None)
    assert job_row == ("published", None)
    assert ("publish.job.published",) in events


def test_normalize_publish_result_uses_url_as_external_id_for_url_targets():
    status, external_id, _, url, error, skipped, _ = normalize_publish_result(
        {"ok": True, "url": "https://example.com/post/1"}
    )

    assert status == "published"
    assert external_id == "https://example.com/post/1"
    assert url == "https://example.com/post/1"
    assert error is None
    assert skipped == 0


def test_normalize_publish_result_keeps_id_and_url_contract():
    status, external_id, _, url, error, skipped, raw = normalize_publish_result(
        {"ok": True, "id": "id-1", "url": "https://example.com/id-1"}
    )

    assert status == "published"
    assert external_id == "id-1"
    assert url == "https://example.com/id-1"
    assert error is None
    assert skipped == 0
    assert '"ok": true' in raw


def test_normalize_publish_result_adds_retryable_contract():
    status, _, _, _, error, _, raw = normalize_publish_result({"ok": False, "error": "timeout while publishing"})

    assert status == "failed"
    assert error == "timeout while publishing"
    assert json.loads(raw)["retryable"] is True


def test_failed_completion_clears_stale_target_url(paths):
    enqueue(paths)
    with sqlite3.connect(paths.pipeline_db) as conn:
        conn.execute(
            """
            INSERT INTO post_targets(post_key, target, status, external_id, url, updated_at)
            VALUES('telegram:alexgetmancom:999', 'linkedin', 'published', 'old-id', 'https://old.example', 'now')
            """
        )
        conn.commit()
    job = claim_due_publish_jobs(worker="w1", paths=paths)[0]
    complete_publish_job(job["job_id"], {"ok": False, "reason": "api rejected"}, paths)

    with sqlite3.connect(paths.pipeline_db) as conn:
        target = conn.execute(
            "SELECT status, external_id, url, error FROM post_targets WHERE target='linkedin'"
        ).fetchone()

    assert target == ("failed", None, None, "api rejected")


def test_transient_failure_schedules_retry(paths):
    enqueue(paths)
    job = claim_due_publish_jobs(worker="w1", paths=paths)[0]
    fail_publish_job(job["job_id"], HTTPError("https://example.com", 503, "unavailable", None, None), paths)

    with sqlite3.connect(paths.pipeline_db) as conn:
        row = conn.execute("SELECT status, attempt_count, next_attempt_at, last_error FROM publish_jobs").fetchone()
        target = conn.execute("SELECT status, error FROM post_targets WHERE target='linkedin'").fetchone()

    assert row[0] == "queued"
    assert row[1] == 1
    assert row[2]
    assert "503" in row[3]
    assert target[0] == "queued"


def test_permanent_failure_stops_retry(paths):
    enqueue(paths)
    job = claim_due_publish_jobs(worker="w1", paths=paths)[0]
    fail_publish_job(job["job_id"], HTTPError("https://example.com", 403, "forbidden", None, None), paths)

    with sqlite3.connect(paths.pipeline_db) as conn:
        row = conn.execute("SELECT status, attempt_count, next_attempt_at FROM publish_jobs").fetchone()
        target = conn.execute("SELECT status, error FROM post_targets WHERE target='linkedin'").fetchone()

    assert row[0] == "failed"
    assert row[1] == 1
    assert row[2] is None
    assert target[0] == "failed"


def test_claim_respects_publish_at(paths):
    enqueue_publish_message(
        999,
        {"targets": {"linkedin": True}},
        {"message_id": 999, "text_ru": "ru", "media_ru": None},
        {"message_id": 999, "text_ru": "ru", "targets": {"linkedin": True}},
        paths,
        publish_at_by_target={"linkedin": "2999-01-01T00:00:00+00:00"},
    )

    assert claim_due_publish_jobs(worker="w1", paths=paths) == []
    with sqlite3.connect(paths.pipeline_db) as conn:
        conn.execute("UPDATE publish_jobs SET publish_at='2000-01-01T00:00:00+00:00'")
        conn.commit()

    claimed = claim_due_publish_jobs(worker="w1", paths=paths)
    assert len(claimed) == 1


def test_enqueue_adds_scheduled_site_en_job(paths):
    enqueue_publish_message(
        999,
        {"targets": {"site_ru": True, "site_en": True}},
        {"message_id": 999, "text_ru": "ru", "media_ru": None},
        {"message_id": 999, "text_ru": "ru", "targets": {"site_ru": True, "site_en": True}},
        paths,
        publish_at_by_target={"site_en": "2026-06-25T00:37:00+00:00"},
    )

    with sqlite3.connect(paths.pipeline_db) as conn:
        rows = conn.execute("SELECT reason, next_attempt_at FROM site_jobs ORDER BY job_id").fetchall()
    assert rows == [
        ("publish", None),
        ("publish_en", "2026-06-25T00:37:00+00:00"),
    ]


def test_migrate_scheduled_message_moves_jobs_and_results(paths):
    enqueue_publish_message(
        -7,
        {"targets": {"linkedin": True}, "text_en": "EN"},
        {"message_id": -7, "text_ru": "RU", "media_ru": None},
        paths=paths,
        enqueue_targets={"linkedin": True},
        publish_at_by_target={"linkedin": "2026-06-25T00:37:00+00:00"},
    )
    with sqlite3.connect(paths.pipeline_db) as conn:
        conn.execute(
            """
            INSERT INTO post_targets(post_key, target, status, external_id, updated_at)
            VALUES('telegram:alexgetmancom:-7', 'linkedin', 'published', 'li-7', 'now')
            """
        )
        conn.commit()

    migrated = migrate_scheduled_message(
        -7,
        999,
        {"message_id": 999, "text_ru": "RU", "media_ru": None},
        {"targets": {"linkedin": True}, "text_en": "EN"},
        paths,
    )

    assert migrated == {"linkedin"}
    with sqlite3.connect(paths.pipeline_db) as conn:
        job = conn.execute("SELECT message_id, post_key, payload_json FROM publish_jobs").fetchone()
        target = conn.execute(
            "SELECT post_key, status, external_id FROM post_targets WHERE target='linkedin'"
        ).fetchone()
        plans = conn.execute("SELECT message_id FROM publish_plans ORDER BY message_id").fetchall()
    assert job[0] == 999
    assert job[1] == "telegram:alexgetmancom:999"
    assert json.loads(job[2])["message_id"] == 999
    assert target == ("telegram:alexgetmancom:999", "published", "li-7")
    assert plans == [(999,)]


def test_canonical_queue_uses_post_id_without_telegram(paths):
    with sqlite3.connect(paths.pipeline_db) as conn:
        conn.execute(
            """
            INSERT INTO publications(post_id, draft_id, status, created_at, updated_at)
            VALUES(1, 7, 'approved', 'now', 'now')
            """
        )
        conn.commit()
    enqueue_publication(
        1,
        {"targets": {"linkedin": True}, "text_en": "EN"},
        {
            "post_id": 1,
            "telegram_message_id": None,
            "text_ru": "",
            "text_en": "EN",
            "media_ru": None,
        },
        paths=paths,
        enqueue_targets={"linkedin": True},
    )

    claimed = claim_due_publish_jobs(worker="w1", paths=paths)

    assert len(claimed) == 1
    assert claimed[0]["post_id"] == 1
    assert claimed[0]["post_key"] == "post:1"
    assert claimed[0]["payload"]["telegram_message_id"] is None
