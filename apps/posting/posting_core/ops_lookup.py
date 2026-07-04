from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PublicationRef:
    input: str
    post_key: str
    post_id: int | None
    message_id: int | None


def _int_or_none(value) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except Exception:
        return None


def _row_to_ref(raw: str, row) -> PublicationRef:
    post_key = row["post_key"] if "post_key" in row.keys() and row["post_key"] else None
    post_id = _int_or_none(row["post_id"] if "post_id" in row.keys() else None)
    message_id = _int_or_none(row["message_id"] if "message_id" in row.keys() else None)
    if not post_key and post_id:
        post_key = f"post:{post_id}"
    if not post_key and message_id:
        post_key = f"telegram:alexgetmancom:{message_id}"
    if not post_key:
        raise ValueError(f"cannot resolve publication ref: {raw}")
    return PublicationRef(input=raw, post_key=post_key, post_id=post_id, message_id=message_id)


def resolve_publication_ref(conn, value: str | int) -> PublicationRef:
    raw = str(value).strip()
    if not raw:
        raise ValueError("empty publication reference")

    if raw.startswith("post:") or raw.startswith("telegram:"):
        row = conn.execute(
            """
            SELECT post_key, post_id, message_id FROM publish_jobs WHERE post_key=? ORDER BY updated_at DESC LIMIT 1
            """,
            (raw,),
        ).fetchone()
        if not row:
            row = conn.execute(
                "SELECT post_key, NULL AS post_id, NULL AS message_id FROM post_targets WHERE post_key=? LIMIT 1",
                (raw,),
            ).fetchone()
        if not row:
            row = conn.execute(
                "SELECT post_key, post_id, message_id FROM posts WHERE post_key=? LIMIT 1",
                (raw,),
            ).fetchone()
        if not row and raw.startswith("post:"):
            post_id = _int_or_none(raw.split(":", 1)[1])
            if post_id is not None:
                return PublicationRef(input=raw, post_key=raw, post_id=post_id, message_id=None)
        if not row:
            raise ValueError(f"publication {raw} not found")
        return _row_to_ref(raw, row)

    if raw.startswith(("message:", "msg:", "m:")):
        message_id = _int_or_none(raw.split(":", 1)[1])
        if message_id is None:
            raise ValueError(f"bad message reference: {raw}")
        row = conn.execute(
            "SELECT post_key, post_id, message_id FROM posts WHERE message_id=? LIMIT 1",
            (message_id,),
        ).fetchone()
        if not row:
            row = conn.execute(
                "SELECT post_key, post_id, message_id FROM publish_jobs WHERE message_id=? ORDER BY updated_at DESC LIMIT 1",
                (message_id,),
            ).fetchone()
        if not row:
            raise ValueError(f"message {message_id} not found")
        return _row_to_ref(raw, row)

    numeric = _int_or_none(raw)
    if numeric is None:
        raise ValueError(f"unsupported publication reference: {raw}")

    post_key = f"post:{numeric}"
    row = conn.execute(
        "SELECT post_key, post_id, message_id FROM publish_jobs WHERE post_key=? OR post_id=? ORDER BY updated_at DESC LIMIT 1",
        (post_key, numeric),
    ).fetchone()
    if not row:
        row = conn.execute(
            "SELECT post_key, NULL AS post_id, NULL AS message_id FROM post_targets WHERE post_key=? LIMIT 1",
            (post_key,),
        ).fetchone()
    if not row:
        row = conn.execute(
            "SELECT 'post:' || post_id AS post_key, post_id, telegram_message_id AS message_id FROM publications WHERE post_id=? LIMIT 1",
            (numeric,),
        ).fetchone()
    if not row:
        row = conn.execute(
            "SELECT 'post:' || post_id AS post_key, post_id, NULL AS message_id FROM post_locales WHERE post_id=? LIMIT 1",
            (numeric,),
        ).fetchone()
    if row:
        return _row_to_ref(raw, row)

    row = conn.execute(
        "SELECT post_key, post_id, message_id FROM posts WHERE message_id=? LIMIT 1",
        (numeric,),
    ).fetchone()
    if row:
        return _row_to_ref(raw, row)

    raise ValueError(f"publication {raw} not found")

