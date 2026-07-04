import json
import os
from datetime import datetime, timezone

import pytest

os.environ.setdefault("CONTROLLER_BOT_TOKEN", "test-token")

from posting_core.controller import schedule as controller_schedule
from posting_core.db import connect, ensure_pipeline_schema
from posting_core.paths import PostingPaths
from posting_core.publications import (
    ensure_publication,
    release_unpublished_publication,
    sync_publication_from_draft,
)
from posting_core.queue import enqueue_publication
from posting_core.scheduling import MSK, paired_schedule


def msk_times(pairs):
    return [
        (
            ru_at.astimezone(MSK).strftime("%Y-%m-%d %H:%M"),
            en_at.astimezone(MSK).strftime("%Y-%m-%d %H:%M"),
        )
        for ru_at, en_at in pairs
    ]


def test_independent_slots_at_0122_cross_midnight():
    now = datetime(2026, 6, 24, 1, 22, tzinfo=MSK)

    assert msk_times(paired_schedule(now, 5)) == [
        ("2026-06-24 10:37", "2026-06-24 03:37"),
        ("2026-06-24 13:37", "2026-06-24 06:37"),
        ("2026-06-24 17:37", "2026-06-24 17:37"),
        ("2026-06-24 20:37", "2026-06-24 20:37"),
        ("2026-06-24 23:37", "2026-06-25 00:37"),
    ]


def test_independent_slots_at_2100_use_ru_today_en_tomorrow():
    now = datetime(2026, 6, 24, 21, 0, tzinfo=MSK)

    assert msk_times(paired_schedule(now, 1)) == [
        ("2026-06-24 23:37", "2026-06-25 00:37"),
    ]


@pytest.fixture
def controller_db(tmp_path, monkeypatch):
    paths = PostingPaths(
        data_dir=tmp_path,
        pipeline_db=tmp_path / "pipeline.db",
        controller_db=tmp_path / "controller.db",
    )
    with connect(paths.pipeline_db) as conn:
        ensure_pipeline_schema(conn)
        for draft_id in range(1, 8):
            conn.execute(
                """
                INSERT INTO drafts(
                    id, admin_id, status, text_ru, text_en_machine,
                    text_en_approved, targets_json, created_at, updated_at
                )
                VALUES (?, 1, 'needs_review', 'RU', 'EN', 'EN', ?, ?, ?)
                """,
                (
                    draft_id,
                    json.dumps(
                        {
                            "telegram": True,
                            "site_ru": True,
                            "site_en": True,
                            "threads_en": True,
                            "linkedin": True,
                        }
                    ),
                    f"2026-06-24T0{draft_id}:00:00+00:00",
                    "2026-06-24T01:00:00+00:00",
                ),
            )
        conn.commit()

    def get_draft(draft_id):
        with connect(paths.pipeline_db) as conn:
            row = conn.execute("SELECT * FROM drafts WHERE id=?", (int(draft_id),)).fetchone()
            return dict(row) if row else None

    monkeypatch.setattr(controller_schedule, "db", lambda: connect(paths.pipeline_db))
    monkeypatch.setattr(controller_schedule, "get_draft", get_draft)
    monkeypatch.setattr(
        controller_schedule,
        "ensure_publication",
        lambda draft_id: ensure_publication(draft_id, paths),
    )
    monkeypatch.setattr(
        controller_schedule,
        "sync_publication_from_draft",
        lambda draft, targets: sync_publication_from_draft(draft, targets, paths),
    )
    monkeypatch.setattr(
        controller_schedule,
        "enqueue_publication",
        lambda *args, **kwargs: enqueue_publication(*args, paths=paths, **kwargs),
    )
    monkeypatch.setattr(
        controller_schedule,
        "cancel_publication_jobs",
        lambda post_id: set(),
    )
    monkeypatch.setattr(
        controller_schedule,
        "release_unpublished_publication",
        lambda post_id: release_unpublished_publication(post_id, paths),
    )
    return paths


def test_schedule_creates_early_en_jobs(controller_db):
    now = datetime(2026, 6, 24, 1, 22, tzinfo=MSK)

    result = controller_schedule.schedule_draft(1, now=now)

    assert datetime.fromisoformat(result["scheduled_at"]).astimezone(MSK) == datetime(2026, 6, 24, 10, 37, tzinfo=MSK)
    assert datetime.fromisoformat(result["scheduled_en_at"]).astimezone(MSK) == datetime(2026, 6, 24, 3, 37, tzinfo=MSK)
    with connect(controller_db.pipeline_db) as conn:
        rows = conn.execute("SELECT post_id, target, status, publish_at FROM publish_jobs ORDER BY target").fetchall()
    assert [(row["post_id"], row["target"], row["status"]) for row in rows] == [
        (1, "linkedin", "queued"),
        (1, "threads_en", "queued"),
    ]
    assert all(datetime.fromisoformat(row["publish_at"]).astimezone(MSK).strftime("%H:%M") == "03:37" for row in rows)


def test_fifth_scheduled_post_uses_en_next_day(controller_db):
    now = datetime(2026, 6, 24, 1, 22, tzinfo=MSK)
    for draft_id in range(1, 6):
        controller_schedule.schedule_draft(draft_id, now=now)

    with connect(controller_db.pipeline_db) as conn:
        row = conn.execute("SELECT scheduled_at, scheduled_en_at FROM drafts WHERE id=5").fetchone()
    assert datetime.fromisoformat(row["scheduled_at"]).astimezone(MSK) == datetime(2026, 6, 24, 23, 37, tzinfo=MSK)
    assert datetime.fromisoformat(row["scheduled_en_at"]).astimezone(MSK) == datetime(2026, 6, 25, 0, 37, tzinfo=MSK)


def test_immediate_post_shifts_both_queues_one_slot(controller_db):
    now = datetime(2026, 6, 24, 1, 22, tzinfo=MSK)
    controller_schedule.schedule_draft(1, now=now)
    controller_schedule.schedule_draft(2, now=now)
    urgent_at = datetime(2026, 6, 24, 1, 24, tzinfo=MSK)
    with connect(controller_db.pipeline_db) as conn:
        conn.execute(
            """
            UPDATE drafts
            SET status='published', publish_mode='immediate',
                scheduled_at=?, scheduled_en_at=?
            WHERE id=7
            """,
            (
                urgent_at.astimezone(timezone.utc).isoformat(),
                urgent_at.astimezone(timezone.utc).isoformat(),
            ),
        )
        conn.commit()

    controller_schedule.rebalance_all_scheduled_drafts(now=urgent_at)

    with connect(controller_db.pipeline_db) as conn:
        rows = conn.execute(
            """
            SELECT id, scheduled_at, scheduled_en_at
            FROM drafts
            WHERE id IN (1, 2)
            ORDER BY id
            """
        ).fetchall()
    assert [datetime.fromisoformat(row["scheduled_at"]).astimezone(MSK).strftime("%H:%M") for row in rows] == [
        "13:37",
        "17:37",
    ]
    assert [datetime.fromisoformat(row["scheduled_en_at"]).astimezone(MSK).strftime("%H:%M") for row in rows] == [
        "06:37",
        "17:37",
    ]


def test_cancel_compacts_remaining_queue(controller_db):
    now = datetime(2026, 6, 24, 1, 22, tzinfo=MSK)
    controller_schedule.schedule_draft(1, now=now)
    controller_schedule.schedule_draft(2, now=now)

    controller_schedule.cancel_scheduled_draft(1, now=now)

    with connect(controller_db.pipeline_db) as conn:
        row = conn.execute("SELECT scheduled_at, scheduled_en_at FROM drafts WHERE id=2").fetchone()
    assert datetime.fromisoformat(row["scheduled_at"]).astimezone(MSK).strftime("%H:%M") == "10:37"
    assert datetime.fromisoformat(row["scheduled_en_at"]).astimezone(MSK).strftime("%H:%M") == "03:37"


def test_disabling_all_en_targets_removes_queued_jobs(controller_db):
    now = datetime(2026, 6, 24, 1, 22, tzinfo=MSK)
    controller_schedule.schedule_draft(1, now=now)
    with connect(controller_db.pipeline_db) as conn:
        conn.execute(
            "UPDATE drafts SET targets_json=? WHERE id=1",
            (json.dumps({"telegram": True, "site_ru": True}),),
        )
        conn.commit()

    controller_schedule.rebalance_all_scheduled_drafts(now=now)

    with connect(controller_db.pipeline_db) as conn:
        rows = conn.execute("SELECT target FROM publish_jobs WHERE post_id=1").fetchall()
    assert rows == []


def test_publish_due_scheduled_drafts(monkeypatch, controller_db):
    with connect(controller_db.pipeline_db) as conn:
        conn.execute(
            """
            UPDATE drafts
            SET status='scheduled',
                scheduled_at='2026-06-24T10:00:00+00:00',
                scheduled_en_at='2026-06-24T17:37:00+00:00'
            WHERE id=1
            """
        )
        conn.commit()
    calls = []
    monkeypatch.setattr(
        controller_schedule,
        "publish_to_channel",
        lambda draft, publish_at_en=None, publish_now=True: (
            calls.append((draft["id"], publish_at_en, publish_now)) or 430
        ),
    )
    monkeypatch.setattr(controller_schedule, "api", lambda method, payload: {"ok": True})

    count = controller_schedule.publish_due_scheduled_drafts(now=datetime(2026, 6, 24, 11, 0, tzinfo=timezone.utc))

    assert count == 1
    assert calls == [(1, "2026-06-24T17:37:00+00:00", False)]
