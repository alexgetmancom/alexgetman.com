import sqlite3

from posting_core.control import alerts
from posting_core.control.config import now_iso
from posting_core.db import ensure_pipeline_schema


def test_send_alerts_suppresses_duplicate_batch_rows(monkeypatch):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    ensure_pipeline_schema(conn)
    now = now_iso()
    for _ in range(2):
        conn.execute(
            """
            INSERT INTO post_events(post_key, event_type, severity, target, message, details_json, created_at)
            VALUES ('telegram:alexgetmancom:1', 'publish.job.failed', 'error', 'x', 'same error', '{}', ?)
            """,
            (now,),
        )
    conn.commit()

    calls = []
    monkeypatch.setattr(alerts, "CONTROLLER_BOT_TOKEN", "token")
    monkeypatch.setattr(alerts, "ADMIN_IDS", [100])
    monkeypatch.setattr(
        alerts, "call_telegram", lambda method, payload, token=None: calls.append((method, payload, token))
    )

    sent = alerts.send_alerts(conn)

    assert sent == 1
    assert len(calls) == 1
    assert calls[0][1]["text"].count("same error") == 1
    assert calls[0][2] == "token"
    assert conn.execute("SELECT COUNT(*) AS c FROM post_events WHERE acked_at IS NULL").fetchone()["c"] == 0
    assert conn.execute("SELECT suppressed_count FROM alert_dedup").fetchone()["suppressed_count"] == 1
    conn.close()
