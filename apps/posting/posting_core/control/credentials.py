from __future__ import annotations

import os

from posting_core.control.config import CREDENTIAL_REQUIREMENTS, json_dumps, now_iso
from posting_core.control.events import emit_event_once

def sync_credentials(conn):
    ts = now_iso()
    for target, names in CREDENTIAL_REQUIREMENTS.items():
        missing = [name for name in names if not os.environ.get(name)]
        status = "ready" if not missing else "missing"
        missing_json = json_dumps(missing)
        existing = conn.execute("SELECT status, missing_env_json FROM credential_checks WHERE target=?", (target,)).fetchone()
        conn.execute(
            """
            INSERT INTO credential_checks(target, status, required_env_json, missing_env_json, last_checked_at, details_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(target) DO UPDATE SET
                status=excluded.status,
                required_env_json=excluded.required_env_json,
                missing_env_json=excluded.missing_env_json,
                last_checked_at=excluded.last_checked_at,
                details_json=excluded.details_json
            """,
            (target, status, json_dumps(names), missing_json, ts, json_dumps({"source": "env_presence"})),
        )
        changed = not existing or existing["status"] != status or existing["missing_env_json"] != missing_json
        if missing and changed:
            emit_event_once(conn, None, "credential.missing", f"{target}: missing {', '.join(missing)}", severity="warn", target=target, details={"missing": missing})
    conn.commit()
