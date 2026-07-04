import json
import sqlite3
from datetime import datetime, timezone, timedelta

import pytest

from posting_core.db import ensure_pipeline_schema
from posting_core.metrics.maintenance import apply_backfill_plan, build_backfill_plan
from posting_core.metrics.schedule import ensure_metric_schedule, finish_metric_task
from posting_core.metrics_config import metric_interval_for_post


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(tmp_path / "pipeline.db")
    connection.row_factory = sqlite3.Row
    ensure_pipeline_schema(connection)
    yield connection
    connection.close()


@pytest.mark.parametrize(
    ("check_count", "expected"),
    [
        (0, timedelta(hours=3)),
        (1, timedelta(hours=6)),
        (2, timedelta(hours=12)),
        (3, timedelta(hours=24)),
        (4, timedelta(hours=48)),
        (5, timedelta(days=7)),
        (6, timedelta(days=30)),
        (7, None),
        (8, None),
    ],
)
def test_intervals_mapping(check_count, expected):
    assert metric_interval_for_post("2026-06-23T12:00:00+00:00", check_count=check_count) == expected


def test_ensure_metric_schedule_schedules_first_in_1_hour(conn):
    post_date = "2026-06-23T12:00:00+00:00"
    conn.execute(
        """
        INSERT INTO posts (post_key, channel, message_id, date_utc, status, created_at, updated_at)
        VALUES ('telegram:alexgetmancom:100', 'alexgetmancom', 100, ?, 'active', '...', '...')
        """,
        (post_date,),
    )
    conn.execute(
        """
        INSERT INTO post_targets (post_key, target, status, updated_at)
        VALUES ('telegram:alexgetmancom:100', 'telegram', 'published', '...')
        """
    )
    conn.commit()

    ensure_metric_schedule(conn)

    row = conn.execute("SELECT * FROM metric_schedule").fetchone()
    assert row is not None
    assert row["post_key"] == "telegram:alexgetmancom:100"
    assert row["target"] == "telegram"
    assert row["next_check_at"] == "2026-06-23T13:00:00+00:00"
    assert row["check_count"] == 0


def test_finish_metric_task_advances_steps(conn):
    post_date = "2026-06-23T12:00:00+00:00"
    conn.execute(
        """
        INSERT INTO posts (post_key, channel, message_id, date_utc, status, created_at, updated_at)
        VALUES ('telegram:alexgetmancom:100', 'alexgetmancom', 100, ?, 'active', '...', '...')
        """,
        (post_date,),
    )
    conn.execute(
        """
        INSERT INTO post_targets (post_key, target, status, updated_at)
        VALUES ('telegram:alexgetmancom:100', 'telegram', 'published', '...')
        """
    )
    conn.execute(
        """
        INSERT INTO metric_schedule(post_key, target, next_check_at, check_count, updated_at)
        VALUES ('telegram:alexgetmancom:100', 'telegram', '2026-06-23T13:00:00+00:00', 0, '...')
        """
    )
    conn.commit()

    now = datetime.now(timezone.utc).replace(microsecond=0)
    finish_metric_task(conn, "telegram:alexgetmancom:100", "telegram", post_date)

    row = conn.execute("SELECT * FROM metric_schedule").fetchone()
    assert row["check_count"] == 1
    assert row["next_check_at"] == (now + timedelta(hours=3)).replace(microsecond=0).isoformat()
    assert row["frozen_at"] is None

    now = datetime.now(timezone.utc).replace(microsecond=0)
    finish_metric_task(conn, "telegram:alexgetmancom:100", "telegram", post_date)

    row = conn.execute("SELECT * FROM metric_schedule").fetchone()
    assert row["check_count"] == 2
    assert row["next_check_at"] == (now + timedelta(hours=6)).replace(microsecond=0).isoformat()


def test_backfill_plan_schedules_supported_targets(conn):
    conn.execute(
        """
        INSERT INTO posts (post_key, channel, message_id, date_utc, status, created_at, updated_at)
        VALUES ('post:1', 'alexgetmancom', 438, '2026-06-25T17:42:19+00:00', 'active', '...', '...')
        """
    )
    for target in ("threads_ru", "telegram", "x"):
        conn.execute(
            "INSERT INTO post_targets(post_key, target, status, updated_at) VALUES ('post:1', ?, 'published', '...')",
            (target,),
        )
    conn.commit()

    rows = build_backfill_plan(conn, targets=("threads_ru", "telegram"))
    assert [(row["post_key"], row["target"]) for row in rows] == [("post:1", "telegram"), ("post:1", "threads_ru")]

    assert apply_backfill_plan(conn, rows) == 2
    scheduled = conn.execute("SELECT target, next_check_at, frozen_at FROM metric_schedule ORDER BY target").fetchall()
    assert [dict(row) for row in scheduled] == [
        {"target": "telegram", "next_check_at": None, "frozen_at": None},
        {"target": "threads_ru", "next_check_at": None, "frozen_at": None},
    ]


def test_fetch_facebook_insights_normal_post(monkeypatch):
    calls = []

    def mock_request_json(url, query=None, timeout=None):
        calls.append((url, query))
        if url.endswith("/insights"):
            return {"data": [{"name": "post_total_media_view_unique", "values": [{"value": 150}]}]}
        return {
            "reactions": {"summary": {"total_count": 10}},
            "comments": {"summary": {"total_count": 5}},
            "shares": {"count": 2},
        }

    monkeypatch.setattr("posting_core.metrics.facebook.request_json", mock_request_json)

    from posting_core.metrics.facebook import fetch_facebook_insights

    metrics, error = fetch_facebook_insights("12345", token="token")

    assert error is None
    assert metrics == {"views": 150, "likes": 10, "replies": 5, "reposts": 2}
    assert len(calls) == 2


def test_fetch_facebook_insights_video_fallback(monkeypatch):
    calls = []

    def mock_request_json(url, query=None, timeout=None):
        calls.append((url, query))
        if url.endswith("/insights"):
            raise RuntimeError("not a post insights object")
        if url.endswith("/likes"):
            return {"summary": {"total_count": 8}}
        if url.endswith("/comments"):
            return {"summary": {"total_count": 3}}
        if url.endswith("/video_insights"):
            assert query["metric"] == "fb_reels_total_plays"
            assert "period" not in query
            return {"data": [{"name": "fb_reels_total_plays", "values": [{"value": 42}]}]}
        raise RuntimeError("post fields unavailable for video object")

    monkeypatch.setattr("posting_core.metrics.facebook.request_json", mock_request_json)

    from posting_core.metrics.facebook import fetch_facebook_insights

    metrics, error = fetch_facebook_insights("12345", token="token")

    assert error is None
    assert metrics == {"views": 42, "likes": 8, "replies": 3}
    assert [url.rsplit("/", 1)[-1] for url, _ in calls] == [
        "insights",
        "12345",
        "likes",
        "comments",
        "video_insights",
    ]


def test_fetch_facebook_insights_uses_legacy_video_metric_when_reels_metric_is_empty(monkeypatch):
    def mock_request_json(url, query=None, timeout=None):
        if url.endswith("/insights"):
            return {"data": []}
        if url.endswith("/video_insights"):
            if query["metric"] == "fb_reels_total_plays":
                return {"data": []}
            assert query["metric"] == "total_video_views"
            assert query["period"] == "lifetime"
            return {"data": [{"name": "total_video_views", "values": [{"value": 21}]}]}
        return {
            "reactions": {"summary": {"total_count": 2}},
            "comments": {"summary": {"total_count": 1}},
            "shares": {"count": 0},
        }

    monkeypatch.setattr("posting_core.metrics.facebook.request_json", mock_request_json)

    from posting_core.metrics.facebook import fetch_facebook_insights

    metrics, error = fetch_facebook_insights("12345", token="token")

    assert error is None
    assert metrics == {"views": 21, "likes": 2, "replies": 1, "reposts": 0}


def test_fetch_telegram_metrics(monkeypatch):
    html_content = """
    <div class="tgme_widget_message" data-post="alexgetmancom/100">
      <span class="tgme_widget_message_views">1.2K</span>
      <div class="tgme_widget_message_reactions js-message_reactions">
        <span class="tgme_reaction"><i class="emoji"><b>❤</b></i>10</span>
        <span class="tgme_reaction"><i class="emoji"><b>🔥</b></i>5</span>
      </div>
    </div>
    <div class="tgme_widget_message" data-post="alexgetmancom/101">
      <span class="tgme_widget_message_views">85</span>
    </div>
    """
    monkeypatch.setattr("posting_core.metrics.telegram.request_text", lambda *args, **kwargs: html_content)

    from posting_core.metrics.telegram import fetch_telegram_metrics

    res = fetch_telegram_metrics([100, 101])
    assert res == {
        100: {"views": 1200, "likes": 15},
        101: {"views": 85, "likes": 0},
    }


def test_sync_telegram_metrics(conn, monkeypatch):
    html_content = """
    <div class="tgme_widget_message" data-post="alexgetmancom/100">
      <span class="tgme_widget_message_views">100</span>
      <div class="tgme_widget_message_reactions js-message_reactions">
        <span class="tgme_reaction"><i class="emoji"><b>❤</b></i>3</span>
      </div>
    </div>
    """
    monkeypatch.setattr("posting_core.metrics.telegram.request_text", lambda *args, **kwargs: html_content)

    # Setup database with a dummy Telegram task
    post_date = "2026-06-23T12:00:00+00:00"
    conn.execute(
        """
        INSERT INTO posts (post_key, channel, message_id, date_utc, status, created_at, updated_at)
        VALUES ('telegram:alexgetmancom:100', 'alexgetmancom', 100, ?, 'active', '...', '...')
        """,
        (post_date,),
    )
    conn.execute(
        """
        INSERT INTO post_targets (post_key, target, status, updated_at)
        VALUES ('telegram:alexgetmancom:100', 'telegram', 'published', '...')
        """
    )
    conn.execute(
        """
        INSERT INTO metric_schedule(post_key, target, next_check_at, check_count, updated_at)
        VALUES ('telegram:alexgetmancom:100', 'telegram', '2026-06-23T13:00:00+00:00', 0, '...')
        """
    )
    conn.commit()

    from posting_core.metrics.telegram import sync_telegram_metrics

    tasks = [{"post_key": "telegram:alexgetmancom:100", "target": "telegram", "message_id": 100, "date_utc": post_date}]
    sync_telegram_metrics(conn, tasks)

    # Check metrics are saved
    views_row = conn.execute(
        "SELECT * FROM post_metrics WHERE post_key = ? AND metric_name = 'views'", ("telegram:alexgetmancom:100",)
    ).fetchone()
    assert views_row is not None
    assert views_row["value"] == 100

    likes_row = conn.execute(
        "SELECT * FROM post_metrics WHERE post_key = ? AND metric_name = 'likes'", ("telegram:alexgetmancom:100",)
    ).fetchone()
    assert likes_row is not None
    assert likes_row["value"] == 3

    # Check metric samples are saved
    v_samples = conn.execute(
        "SELECT * FROM metric_samples WHERE post_key = ? AND metric_name = 'views'", ("telegram:alexgetmancom:100",)
    ).fetchall()
    assert len(v_samples) == 1
    assert v_samples[0]["value"] == 100

    l_samples = conn.execute(
        "SELECT * FROM metric_samples WHERE post_key = ? AND metric_name = 'likes'", ("telegram:alexgetmancom:100",)
    ).fetchall()
    assert len(l_samples) == 1
    assert l_samples[0]["value"] == 3


def test_sync_threads_metrics_sums_thread_parts(conn, monkeypatch):
    post_date = "2026-06-23T12:00:00+00:00"
    conn.execute(
        """
        INSERT INTO posts (post_key, channel, message_id, date_utc, status, created_at, updated_at)
        VALUES ('post:20', 'alexgetmancom', 455, ?, 'active', '...', '...')
        """,
        (post_date,),
    )
    conn.execute(
        """
        INSERT INTO post_targets (post_key, target, status, external_id, external_ids_json, url, updated_at)
        VALUES ('post:20', 'threads_en', 'published', 'root', '["root","reply"]', 'https://threads/root', '...')
        """
    )
    conn.execute(
        """
        INSERT INTO metric_schedule(post_key, target, next_check_at, check_count, updated_at)
        VALUES ('post:20', 'threads_en', '2026-06-23T13:00:00+00:00', 0, '...')
        """
    )
    conn.commit()

    def fake_fetch(threads_id, token=None):
        if threads_id == "root":
            return {"views": 10, "likes": 2, "replies": 1}, None
        return {"views": 5, "likes": 3, "reposts": 1}, None

    monkeypatch.setattr("posting_core.metrics.threads.fetch_threads_insights", fake_fetch)

    from posting_core.metrics.threads import sync_threads_metrics

    tasks = [
        {
            "post_key": "post:20",
            "target": "threads_en",
            "external_id": "root",
            "external_ids_json": '["root","reply"]',
            "url": "https://threads/root",
            "date_utc": post_date,
        }
    ]
    sync_threads_metrics(conn, tasks)

    rows = {
        row["metric_name"]: row
        for row in conn.execute("SELECT metric_name, value, raw_json FROM post_metrics WHERE post_key='post:20'")
    }
    assert rows["views"]["value"] == 15
    assert rows["likes"]["value"] == 5
    assert rows["replies"]["value"] == 1
    assert rows["reposts"]["value"] == 1
    assert len(json.loads(rows["views"]["raw_json"])["parts"]) == 2


def test_sync_bluesky_metrics_sums_thread_parts(conn, monkeypatch):
    post_date = "2026-06-23T12:00:00+00:00"
    conn.execute(
        """
        INSERT INTO posts (post_key, channel, message_id, date_utc, status, created_at, updated_at)
        VALUES ('post:21', 'alexgetmancom', 456, ?, 'active', '...', '...')
        """,
        (post_date,),
    )
    conn.execute(
        """
        INSERT INTO post_targets (post_key, target, status, external_id, external_ids_json, url, updated_at)
        VALUES ('post:21', 'bluesky', 'published', 'at://root', '["at://root","at://reply"]', 'https://bsky/root', '...')
        """
    )
    conn.execute(
        """
        INSERT INTO metric_schedule(post_key, target, next_check_at, check_count, updated_at)
        VALUES ('post:21', 'bluesky', '2026-06-23T13:00:00+00:00', 0, '...')
        """
    )
    conn.commit()

    monkeypatch.setattr(
        "posting_core.metrics.social.request_json",
        lambda *args, **kwargs: {
            "posts": [
                {"uri": "at://root", "likeCount": 2, "replyCount": 1, "repostCount": 3, "quoteCount": 4},
                {"uri": "at://reply", "likeCount": 5, "replyCount": 0, "repostCount": 1, "quoteCount": 0},
            ]
        },
    )

    from posting_core.metrics.social import sync_other_social_metrics

    tasks = [
        {
            "post_key": "post:21",
            "target": "bluesky",
            "external_id": "at://root",
            "external_ids_json": '["at://root","at://reply"]',
            "url": "https://bsky/root",
            "date_utc": post_date,
        }
    ]
    sync_other_social_metrics(conn, tasks)

    rows = {
        row["metric_name"]: row["value"]
        for row in conn.execute("SELECT metric_name, value FROM post_metrics WHERE post_key='post:21'")
    }
    assert rows == {"likes": 7, "quotes": 4, "replies": 1, "reposts": 4}


def test_sync_devto_metrics_prefers_authenticated_article_views(conn, monkeypatch):
    post_date = "2026-06-23T12:00:00+00:00"
    conn.execute(
        """
        INSERT INTO posts (post_key, channel, message_id, date_utc, status, created_at, updated_at)
        VALUES ('post:22', 'alexgetmancom', 457, ?, 'active', '...', '...')
        """,
        (post_date,),
    )
    conn.execute(
        """
        INSERT INTO post_targets (post_key, target, status, external_id, url, updated_at)
        VALUES (
          'post:22',
          'devto',
          'published',
          'https://dev.to/alexgetmancom/test-slug',
          'https://dev.to/alexgetmancom/test-slug',
          '...'
        )
        """
    )
    conn.commit()

    calls = []

    def fake_request_json(url, **kwargs):
        calls.append((url, kwargs))
        if url == "https://dev.to/api/articles/me":
            return [
                {
                    "id": 42,
                    "slug": "test-slug",
                    "url": "https://dev.to/alexgetmancom/test-slug",
                    "page_views_count": 123,
                    "public_reactions_count": 7,
                    "comments_count": 2,
                }
            ]
        raise AssertionError("public Dev.to endpoint should not be used when auth article is found")

    monkeypatch.setattr("posting_core.metrics.social.DEVTO_API_KEY", "devto-token")
    monkeypatch.setattr("posting_core.metrics.social.request_json", fake_request_json)

    from posting_core.metrics.social import sync_other_social_metrics

    sync_other_social_metrics(
        conn,
        [
            {
                "post_key": "post:22",
                "target": "devto",
                "external_id": "https://dev.to/alexgetmancom/test-slug",
                "url": "https://dev.to/alexgetmancom/test-slug",
                "date_utc": post_date,
            }
        ],
    )

    rows = {
        row["metric_name"]: row["value"]
        for row in conn.execute("SELECT metric_name, value FROM post_metrics WHERE post_key='post:22'")
    }
    assert rows == {"likes": 7, "replies": 2, "views": 123}
    assert calls[0][0] == "https://dev.to/api/articles/me"
