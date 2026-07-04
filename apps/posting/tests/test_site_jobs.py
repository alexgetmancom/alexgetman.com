from posting_core.db import connect, ensure_pipeline_schema
from site_feed import site_jobs


def test_latest_site_build_status_ignores_cancelled_jobs(tmp_path, monkeypatch):
    db_path = tmp_path / "pipeline.db"
    with connect(db_path) as conn:
        ensure_pipeline_schema(conn)
        conn.execute(
            """
            INSERT INTO site_jobs(message_id, reason, status, attempt_count, last_error, created_at, updated_at)
            VALUES(0, 'startup_reconcile', 'published', 0, NULL, '2026-06-23T18:00:00+00:00', '2026-06-23T18:00:00+00:00')
            """
        )
        conn.execute(
            """
            INSERT INTO site_jobs(message_id, reason, status, attempt_count, last_error, created_at, updated_at)
            VALUES(0, 'startup_reconcile', 'cancelled', 2, 'old error', '2026-06-23T18:01:00+00:00', '2026-06-23T18:01:00+00:00')
            """
        )
        conn.execute(
            """
            INSERT INTO post_events(event_type, severity, message, created_at)
            VALUES('site.build.published', 'info', 'published', '2026-06-23T18:00:00+00:00')
            """
        )
        conn.execute(
            """
            INSERT INTO post_events(event_type, severity, message, created_at)
            VALUES('site.build.cancelled', 'info', 'cancelled old job', '2026-06-23T18:01:00+00:00')
            """
        )
        conn.commit()

    monkeypatch.setattr(site_jobs, "PIPELINE_DB", db_path)
    status = site_jobs.latest_site_build_status()

    assert status["status"] == "published"
    assert status["last_error"] is None
    assert status["queue_depth"] == 0
    assert status["last_event"]["event_type"] == "site.build.published"
