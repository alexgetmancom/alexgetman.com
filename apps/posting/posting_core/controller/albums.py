from __future__ import annotations

import json
import time
from datetime import datetime

from posting_core.controller.config import ALBUM_SETTLE_SECONDS, api, log
from posting_core.controller.db import db, set_state, update_draft
from posting_core.controller.drafts import create_draft
from posting_core.controller.media import media_json_value
from posting_core.controller.ui import send_preview
from posting_core.time_utils import now_iso


def album_key(admin_id, chat_id, media_group_id, action=None, draft_id=None):
    return f"{admin_id}:{chat_id}:{media_group_id}:{action or 'draft'}:{draft_id or ''}"


def append_pending_album(admin_id, chat_id, media_group_id, text_ru, media, action=None, draft_id=None, entities=None):
    if not media:
        return
    key = album_key(admin_id, chat_id, media_group_id, action, draft_id)
    with db() as conn:
        row = conn.execute("SELECT * FROM pending_albums WHERE id=?", (key,)).fetchone()
        if row:
            items = json.loads(row["media_json"])
            items.append(media)
            new_text = text_ru or row["text_ru"] or ""
            entities_json = json.dumps(entities or json.loads(row["text_entities_json"] or "[]"), ensure_ascii=False)
            conn.execute(
                "UPDATE pending_albums SET text_ru=?, text_entities_json=?, media_json=?, updated_at=? WHERE id=?",
                (new_text, entities_json, json.dumps(items, ensure_ascii=False), now_iso(), key),
            )
            notified = row["notified"]
        else:
            conn.execute(
                "INSERT INTO pending_albums(id,admin_id,chat_id,media_group_id,action,draft_id,text_ru,text_entities_json,media_json,notified,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    key,
                    admin_id,
                    chat_id,
                    str(media_group_id),
                    action,
                    draft_id,
                    text_ru or "",
                    json.dumps(entities or [], ensure_ascii=False),
                    json.dumps([media], ensure_ascii=False),
                    0,
                    now_iso(),
                ),
            )
            notified = 0
        conn.commit()
    if not notified:
        api(
            "sendMessage",
            {"chat_id": chat_id, "text": "Album received. I will create/update the draft in a few seconds."},
        )
        with db() as conn:
            conn.execute("UPDATE pending_albums SET notified=1 WHERE id=?", (key,))
            conn.commit()


def finalize_pending_albums():
    deadline = time.time() - ALBUM_SETTLE_SECONDS
    with db() as conn:
        rows = [dict(row) for row in conn.execute("SELECT * FROM pending_albums")]
    for row in rows:
        try:
            updated_ts = datetime.fromisoformat(row["updated_at"]).timestamp()
        except Exception:
            updated_ts = 0
        if updated_ts > deadline:
            continue
        media_items = json.loads(row["media_json"])
        try:
            if row.get("action") in {"replace_ru_media", "replace_en_media"} and row.get("draft_id"):
                media_field = "media_ru_json" if row.get("action") == "replace_ru_media" else "media_en_json"
                update_draft(
                    row["draft_id"], **{media_field: json.dumps(media_json_value(media_items), ensure_ascii=False)}
                )
                from posting_core.controller.db import get_draft
                from posting_core.controller.schedule import rebalance_all_scheduled_drafts

                if (get_draft(row["draft_id"]) or {}).get("status") == "scheduled":
                    rebalance_all_scheduled_drafts()
                set_state(row["admin_id"])
                send_preview(row["chat_id"], row["draft_id"])
            else:
                draft_id = create_draft(
                    row["admin_id"],
                    row.get("text_ru") or "",
                    media_items,
                    json.loads(row.get("text_entities_json") or "[]"),
                )
                send_preview(row["chat_id"], draft_id)
            with db() as conn:
                conn.execute("DELETE FROM pending_albums WHERE id=?", (row["id"],))
                conn.commit()
        except Exception as exc:
            log(f"failed to finalize album {row['id']}: {exc}")
