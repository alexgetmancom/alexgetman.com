from __future__ import annotations

import json

from posting_core.controller.config import now_iso
from posting_core.controller.db import db
from posting_core.controller.limits import validate_draft_text
from posting_core.controller.media import media_json_value
from posting_core.controller.routing import route_targets_for_media
from posting_core.controller.translation import translate_ru_to_en
from posting_core.targets import DEFAULT_TARGETS

def create_draft(admin_id, text_ru, media, entities=None):
    validate_draft_text(text_ru, "RU")
    text_en = translate_ru_to_en(text_ru)
    with db() as conn:
        media_value = media_json_value(media)
        targets, _, _ = route_targets_for_media(DEFAULT_TARGETS.copy(), media_value)
        cur = conn.execute(
            """
            INSERT INTO drafts(
                admin_id,status,text_ru,text_en_machine,text_en_approved,
                targets_json,media_ru_json,media_en_json,text_ru_entities_json,
                created_at,updated_at
            )
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                admin_id,
                'needs_review',
                text_ru or '',
                text_en,
                text_en,
                json.dumps(targets, ensure_ascii=False),
                json.dumps(media_value, ensure_ascii=False) if media_value else None,
                None,
                json.dumps(entities or [], ensure_ascii=False),
                now_iso(),
                now_iso(),
            ),
        )
        conn.commit()
        return cur.lastrowid
