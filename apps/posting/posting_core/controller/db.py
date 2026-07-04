from __future__ import annotations

from posting_core.controller.config import DATA_DIR, DB_PATH
from posting_core.db import connect as db_connect, ensure_pipeline_schema
from posting_core.time_utils import now_iso


def db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = db_connect(DB_PATH)
    ensure_pipeline_schema(conn)
    return conn


def get_draft(draft_id):
    with db() as conn:
        row = conn.execute('SELECT * FROM drafts WHERE id=?', (draft_id,)).fetchone()
        return dict(row) if row else None


def update_draft(draft_id, **fields):
    if not fields:
        return
    fields['updated_at'] = now_iso()
    with db() as conn:
        sets = ', '.join(f'{k}=?' for k in fields)
        conn.execute(f'UPDATE drafts SET {sets} WHERE id=?', (*fields.values(), draft_id))
        conn.commit()


def set_state(admin_id, action=None, draft_id=None):
    with db() as conn:
        conn.execute('INSERT INTO admin_state(admin_id, action, draft_id, updated_at) VALUES(?,?,?,?) ON CONFLICT(admin_id) DO UPDATE SET action=excluded.action,draft_id=excluded.draft_id,updated_at=excluded.updated_at', (admin_id, action, draft_id, now_iso()))
        conn.commit()


def get_state(admin_id):
    with db() as conn:
        row = conn.execute('SELECT * FROM admin_state WHERE admin_id=?', (admin_id,)).fetchone()
        return dict(row) if row else {}


def get_scheduled_drafts():
    with db() as conn:
        return [
            dict(row)
            for row in conn.execute(
                """
                SELECT *
                FROM drafts
                WHERE status='scheduled'
                ORDER BY COALESCE(scheduled_at, scheduled_en_at), id
                """
            ).fetchall()
        ]
