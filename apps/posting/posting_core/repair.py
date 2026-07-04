from __future__ import annotations

import json
from typing import Any

from .paths import PostingPaths, get_paths
from .time_utils import now_iso
from .repair_social import edit_published_targets
from .repair_repository import RepairRepository
from .targets import ALL_TARGET_IDS


def parse_media(value: str | None) -> list[dict[str, str]] | None:
    value = (value or "").strip()
    if not value or value.lower() in {"none", "null", "ru", "fallback"}:
        return None
    try:
        media = json.loads(value)
    except Exception as exc:
        raise ValueError(f"bad media JSON: {exc}") from exc
    if isinstance(media, dict):
        media = [media]
    if not isinstance(media, list):
        raise ValueError("media JSON must be an object, list, null, or empty")
    normalized = []
    for item in media:
        if not isinstance(item, dict):
            raise ValueError("media items must be objects")
        media_type = item.get("type")
        file_id = item.get("file_id")
        if media_type not in {"photo", "video", "IMAGE", "VIDEO"} or not file_id:
            raise ValueError("each media item needs type photo/video and file_id")
        normalized.append({"type": "video" if str(media_type).upper() == "VIDEO" or media_type == "video" else "photo", "file_id": str(file_id)})
    return normalized or None


class RepairService:
    def __init__(self, paths: PostingPaths | None = None, actor_type: str = "ops"):
        self.paths = paths or get_paths()
        self.actor_type = actor_type
        self.repo = RepairRepository(self.paths)

    def requeue(self, message_id: int | str, target: str | None = None) -> dict[str, Any]:
        if target and target not in ALL_TARGET_IDS:
            raise ValueError(f"unknown target: {target}")

        now = now_iso()
        ref = self.repo.resolve_ref(message_id)
        message_id = ref.message_id
        if message_id is None:
            result = self.repo.requeue_existing_publication(ref, target, now)
            self.repo.record_action("requeue", None, target, "ok", self.actor_type, {"ref": ref.input, "result": result})
            return result
        item, plan = self.repo.load_source_and_plan(message_id)
        if not isinstance(item, dict):
            result = self.repo.requeue_existing_publication(ref, target, now)
            self.repo.record_action("requeue", message_id, target, "ok", self.actor_type, {"ref": ref.input, "result": result})
            return result

        payload = {
            "draft_id": item.get("draft_id"),
            "chat_id": item.get("chat_id"),
            "message_id": message_id,
            "text_ru": item.get("text_ru") or "",
            "media_ru": item.get("media_ru"),
            "created_at": now,
            "requeued_at": now,
            "requeue_target": target,
        }

        targets = plan.get("targets") if isinstance(plan.get("targets"), dict) else (item.get("targets") if isinstance(item.get("targets"), dict) else {})
        if target:
            targets = {name: False for name in ALL_TARGET_IDS}
            targets[target] = True
        plan.update({
            "targets": targets,
            "text_en": plan.get("text_en") or item.get("text_en") or "",
            "media_en": plan.get("media_en") or item.get("media_en"),
            "requeued_at": now,
        })
        self.repo.save_requeue_plan(message_id, plan, now)
        self.repo.reset_target_status(message_id, target)
        self.repo.enqueue_publish_jobs(message_id, targets, payload)
        self.repo.record_action("requeue", message_id, target, "ok", self.actor_type, {"targets": targets})
        return {"ok": True, "message_id": message_id, "target": target, "targets": targets}

    def edit_text(self, message_id: int, text_ru: str | None = None, text_en: str | None = None, edit_external: bool = True) -> dict[str, Any]:
        message_id = int(message_id)
        text_ru = text_ru.strip() if text_ru else None
        text_en = text_en.strip() if text_en else None
        if not text_ru and not text_en:
            raise ValueError("provide text_ru or text_en")
        now = now_iso()

        self.repo.require_db()
        post = self.repo.update_text_and_queue_site_job(message_id, text_ru, text_en, now)

        external = edit_published_targets(self.paths, post, text_ru, text_en) if edit_external and post is not None else []
        self.repo.record_action("edit_text", message_id, None, "ok", self.actor_type, {"text_ru": bool(text_ru), "text_en": bool(text_en), "external": external})
        return {"ok": True, "message_id": message_id, "text_ru": bool(text_ru), "text_en": bool(text_en), "external": external}

    def edit_en(self, message_id: int, text_en: str) -> dict[str, Any]:
        return self.edit_text(message_id, text_en=text_en)

    def replace_en_media(self, message_id: int, media_en: list[dict[str, str]] | None) -> dict[str, Any]:
        message_id = int(message_id)
        now = now_iso()
        self.repo.require_db()
        self.repo.replace_en_media_and_queue_site_job(message_id, media_en, now)
        self.repo.record_action("replace_en_media", message_id, None, "ok", self.actor_type, {"media_en": bool(media_en)})
        return {"ok": True, "message_id": message_id, "media_en": bool(media_en)}
