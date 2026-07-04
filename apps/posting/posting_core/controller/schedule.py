from __future__ import annotations

import json
from datetime import datetime, time, timedelta, timezone

from posting_core.controller.config import api, log
from posting_core.controller.db import db, get_draft
from posting_core.controller.publish import publish_to_channel
from posting_core.publications import ensure_publication, release_unpublished_publication, sync_publication_from_draft
from posting_core.queue import cancel_publication_jobs, enqueue_publication
from posting_core.scheduling import MAX_POSTS_PER_DAY, MSK, daily_slots, format_msk, to_utc_iso
from posting_core.targets import SOCIAL_TARGET_IDS, TARGET_BY_ID
from posting_core.time_utils import now_iso


def _targets_for(draft: dict) -> dict[str, bool]:
    try:
        raw = json.loads(draft.get("targets_json") or "{}")
    except Exception:
        raw = {}
    return {str(key): bool(value) for key, value in raw.items()}


def _media_value(draft: dict, key: str):
    try:
        return json.loads(draft.get(key) or "null")
    except Exception:
        return None


def _day_bounds(day) -> tuple[str, str]:
    start = datetime.combine(day, datetime.min.time(), tzinfo=MSK)
    end = start + timedelta(days=1)
    return to_utc_iso(start), to_utc_iso(end)


def _available_slots(conn, locale: str, now: datetime, needed: int) -> list[datetime]:
    column = "scheduled_at" if locale == "ru" else "scheduled_en_at"
    result: list[datetime] = []
    for offset in range(366):
        day = now.date() + timedelta(days=offset)
        day_start, day_end = _day_bounds(day)
        consumed = conn.execute(
            f"""
            SELECT publish_mode
            FROM drafts
            WHERE {column}>=?
              AND {column}<?
              AND (
                    status='published'
                    OR (status='scheduled' AND {column}<=?)
              )
            """,
            (day_start, day_end, to_utc_iso(now)),
        ).fetchall()
        immediate_count = sum(1 for row in consumed if row["publish_mode"] == "immediate")
        capacity = max(0, MAX_POSTS_PER_DAY - len(consumed))
        candidates = [slot for slot in daily_slots(day, locale) if slot > now]
        if offset == 0 and immediate_count:
            candidates = candidates[immediate_count:]
        result.extend(candidates[:capacity])
        if len(result) >= needed:
            return result[:needed]
    raise RuntimeError(f"No free {locale.upper()} publishing slot found")


def _sync_scheduled_jobs(draft_ids: list[int]) -> None:
    for draft_id in draft_ids:
        draft = get_draft(draft_id)
        if not draft or draft.get("status") != "scheduled":
            continue
        targets = _targets_for(draft)
        post_id = sync_publication_from_draft(draft, targets)
        social_targets = {
            target_id: True
            for target_id in SOCIAL_TARGET_IDS
            if targets.get(target_id)
        }
        with db() as conn:
            rows = conn.execute(
                "SELECT target, status FROM publish_jobs WHERE post_id=?",
                (post_id,),
            ).fetchall()
            final_targets = {
                row["target"]
                for row in rows
                if row["status"] in {"publishing", "published", "skipped"}
            }
            if social_targets:
                placeholders = ",".join("?" for _ in social_targets)
                conn.execute(
                    f"""
                    DELETE FROM publish_jobs
                    WHERE post_id=?
                      AND status IN ('queued', 'failed')
                      AND target NOT IN ({placeholders})
                    """,
                    (post_id, *social_targets),
                )
            else:
                conn.execute(
                    """
                    DELETE FROM publish_jobs
                    WHERE post_id=? AND status IN ('queued', 'failed')
                    """,
                    (post_id,),
                )
            conn.execute(
                "DELETE FROM site_jobs WHERE post_id=? AND status IN ('queued', 'failed')",
                (post_id,),
            )
            conn.commit()
        pending_targets = {
            target_id: enabled
            for target_id, enabled in social_targets.items()
            if target_id not in final_targets
        }
        plan = {
            "draft_id": draft_id,
            "post_id": post_id,
            "targets": targets,
            "text_en": draft.get("text_en_approved") or draft.get("text_en_machine") or "",
            "media_en": _media_value(draft, "media_en_json"),
            "created_at": now_iso(),
            "scheduled_at": draft.get("scheduled_at"),
            "scheduled_en_at": draft.get("scheduled_en_at"),
        }
        job = {
            "draft_id": draft_id,
            "post_id": post_id,
            "chat_id": f"scheduled:{draft_id}",
            "telegram_message_id": draft.get("channel_message_id"),
            "text_ru": draft.get("text_ru") or "",
            "text_en": draft.get("text_en_approved") or draft.get("text_en_machine") or "",
            "media_ru": _media_value(draft, "media_ru_json"),
            "created_at": now_iso(),
            "publish_at_en": draft.get("scheduled_en_at"),
        }
        source_item = {
            **job,
            "date": draft.get("scheduled_at") or draft.get("scheduled_en_at") or now_iso(),
            "telegram_url": None,
            "media_en": _media_value(draft, "media_en_json"),
            "targets": targets,
            "publish_at_ru": draft.get("scheduled_at"),
            "publish_at_en": draft.get("scheduled_en_at"),
        }
        publish_at_by_target = {}
        for target_id in pending_targets:
            locale = TARGET_BY_ID[target_id].locale
            publish_at_by_target[target_id] = (
                draft.get("scheduled_en_at") if locale == "en" else draft.get("scheduled_at")
            )
        if targets.get("site_ru"):
            publish_at_by_target["site_ru"] = draft.get("scheduled_at")
        if targets.get("site_en"):
            publish_at_by_target["site_en"] = draft.get("scheduled_en_at")
        enqueue_publication(
            post_id,
            plan,
            job,
            source_item,
            enqueue_targets=pending_targets,
            publish_at_by_target=publish_at_by_target,
        )


def rebalance_all_scheduled_drafts(now: datetime | None = None) -> None:
    now = (now or datetime.now(timezone.utc)).astimezone(MSK)
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = [
            dict(row)
            for row in conn.execute(
                """
                SELECT *
                FROM drafts
                WHERE status='scheduled'
                ORDER BY created_at, id
                """
            ).fetchall()
        ]
        if not rows:
            conn.commit()
            return

        assignments: dict[int, dict[str, str]] = {
            int(row["id"]): {
                "scheduled_at": row.get("scheduled_at"),
                "scheduled_en_at": row.get("scheduled_en_at"),
            }
            for row in rows
        }
        now_utc = now.astimezone(timezone.utc)
        for locale, column in (("ru", "scheduled_at"), ("en", "scheduled_en_at")):
            pending = []
            for row in rows:
                targets = _targets_for(row)
                has_locale_target = any(
                    enabled
                    and TARGET_BY_ID.get(target_id)
                    and TARGET_BY_ID[target_id].locale == locale
                    for target_id, enabled in targets.items()
                )
                if not has_locale_target:
                    assignments[int(row["id"])][column] = None
                    continue
                value = row.get(column)
                parsed = datetime.fromisoformat(value) if value else None
                if parsed and parsed <= now_utc:
                    continue
                pending.append(row)
            slots = _available_slots(conn, locale, now, len(pending))
            for row, slot in zip(pending, slots):
                assignments[int(row["id"])][column] = to_utc_iso(slot)

        updated_at = to_utc_iso(now)
        for draft_id, values in assignments.items():
            conn.execute(
                """
                UPDATE drafts
                SET scheduled_at=?, scheduled_en_at=?, updated_at=?
                WHERE id=? AND status='scheduled'
                """,
                (
                    values["scheduled_at"],
                    values["scheduled_en_at"],
                    updated_at,
                    draft_id,
                ),
            )
        conn.commit()
    _sync_scheduled_jobs([int(row["id"]) for row in rows])


def schedule_draft(draft_id: int, now: datetime | None = None) -> dict[str, str]:
    now = (now or datetime.now(timezone.utc)).astimezone(MSK)
    draft = get_draft(int(draft_id))
    if not draft:
        raise RuntimeError(f"Draft #{draft_id} not found")
    if draft["status"] not in {"needs_review", "scheduled"}:
        raise RuntimeError(f"Draft #{draft_id} cannot be scheduled from {draft['status']}")
    post_id = ensure_publication(int(draft_id))
    with db() as conn:
        conn.execute(
            """
            UPDATE drafts
            SET status='scheduled', publish_mode='scheduled', post_id=?, updated_at=?
            WHERE id=?
            """,
            (post_id, to_utc_iso(now), int(draft_id)),
        )
        conn.commit()
    rebalance_all_scheduled_drafts(now=now)
    scheduled = get_draft(int(draft_id))
    return {
        "scheduled_at": scheduled["scheduled_at"],
        "scheduled_en_at": scheduled["scheduled_en_at"],
    }


def schedule_draft_at(
    draft_id: int,
    scheduled_at: datetime | None = None,
    scheduled_en_at: datetime | None = None,
    now: datetime | None = None,
) -> dict[str, str]:
    now = (now or datetime.now(timezone.utc)).astimezone(MSK)
    draft = get_draft(int(draft_id))
    if not draft:
        raise RuntimeError(f"Draft #{draft_id} not found")
    if draft["status"] not in {"needs_review", "scheduled"}:
        raise RuntimeError(f"Draft #{draft_id} cannot be scheduled from {draft['status']}")
    if not scheduled_at and not scheduled_en_at:
        raise RuntimeError("At least one schedule time is required")
    post_id = ensure_publication(int(draft_id))
    scheduled_at_iso = to_utc_iso(scheduled_at) if scheduled_at else draft.get("scheduled_at")
    scheduled_en_at_iso = to_utc_iso(scheduled_en_at) if scheduled_en_at else draft.get("scheduled_en_at")
    with db() as conn:
        conn.execute(
            """
            UPDATE drafts
            SET status='scheduled', publish_mode='scheduled', post_id=?,
                scheduled_at=?, scheduled_en_at=?, updated_at=?
            WHERE id=?
            """,
            (post_id, scheduled_at_iso, scheduled_en_at_iso, to_utc_iso(now), int(draft_id)),
        )
        conn.commit()
    _sync_scheduled_jobs([int(draft_id)])
    return {"scheduled_at": scheduled_at_iso, "scheduled_en_at": scheduled_en_at_iso}


def preset_schedule_time(kind: str, now: datetime | None = None) -> datetime:
    now = (now or datetime.now(timezone.utc)).astimezone(MSK)
    if kind == "plus30":
        return now + timedelta(minutes=30)
    if kind == "plus60":
        return now + timedelta(hours=1)
    if kind == "today2100":
        value = datetime.combine(now.date(), time(21, 0), tzinfo=MSK)
        return value if value > now else value + timedelta(days=1)
    if kind == "tomorrow1000":
        return datetime.combine(now.date() + timedelta(days=1), time(10, 0), tzinfo=MSK)
    raise RuntimeError(f"Unknown schedule preset: {kind}")


def parse_manual_schedule(value: str, now: datetime | None = None) -> datetime:
    now = (now or datetime.now(timezone.utc)).astimezone(MSK)
    raw = " ".join(str(value or "").strip().split())
    if not raw:
        raise RuntimeError("Send time as HH:MM or DD.MM HH:MM")
    for fmt in ("%d.%m.%Y %H:%M", "%d.%m %H:%M", "%H:%M"):
        try:
            parsed = datetime.strptime(raw, fmt)
            if fmt == "%H:%M":
                candidate = datetime.combine(now.date(), parsed.time(), tzinfo=MSK)
                return candidate if candidate > now else candidate + timedelta(days=1)
            if fmt == "%d.%m %H:%M":
                parsed = parsed.replace(year=now.year)
            candidate = parsed.replace(tzinfo=MSK)
            if candidate <= now and fmt == "%d.%m %H:%M":
                candidate = candidate.replace(year=now.year + 1)
            return candidate
        except ValueError:
            continue
    raise RuntimeError("Cannot parse time. Use HH:MM or DD.MM HH:MM")


def cancel_scheduled_draft(draft_id: int, now: datetime | None = None) -> None:
    draft = get_draft(int(draft_id))
    final_targets = cancel_publication_jobs(int(draft.get("post_id") or 0)) if draft and draft.get("post_id") else set()
    if final_targets:
        raise RuntimeError(
            "Cannot cancel: EN targets already started or published: "
            + ", ".join(sorted(final_targets))
        )
    with db() as conn:
        conn.execute(
            """
            UPDATE drafts
            SET status='cancelled', scheduled_at=NULL, scheduled_en_at=NULL, updated_at=?
            WHERE id=?
            """,
            (to_utc_iso((now or datetime.now(timezone.utc)).astimezone(MSK)), int(draft_id)),
        )
        conn.commit()
    if draft and draft.get("post_id"):
        release_unpublished_publication(int(draft["post_id"]))
    rebalance_all_scheduled_drafts(now=now)


def publish_due_scheduled_drafts(now: datetime | None = None) -> int:
    due_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(microsecond=0).isoformat()
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id
            FROM drafts
            WHERE status='scheduled'
              AND (
                    (scheduled_at IS NOT NULL AND scheduled_at<=?)
                    OR (
                        scheduled_at IS NULL
                        AND scheduled_en_at IS NOT NULL
                        AND scheduled_en_at<=?
                    )
              )
            ORDER BY COALESCE(scheduled_at, scheduled_en_at), id
            """,
            (due_at, due_at),
        ).fetchall()
    published = 0
    for row in rows:
        draft = get_draft(int(row["id"]))
        try:
            post_id = publish_to_channel(
                draft,
                publish_at_en=draft.get("scheduled_en_at"),
                publish_now=False,
            )
            api(
                "sendMessage",
                {
                    "chat_id": draft["admin_id"],
                    "text": f"Scheduled draft #{draft['id']} published as post #{post_id}.",
                },
            )
            published += 1
        except Exception as exc:
            log(f"scheduled draft #{draft['id']} publish failed: {exc}")
    return published


def schedule_summary(result: dict[str, str]) -> str:
    lines = []
    if result.get("scheduled_at"):
        lines.append(f"RU: {format_msk(result['scheduled_at'])}")
    if result.get("scheduled_en_at"):
        lines.append(f"EN: {format_msk(result['scheduled_en_at'])}")
    return "\n".join(lines)
