#!/usr/bin/env python3
from __future__ import annotations

import time

from posting_core.publish_config import (
    CONTROLLER_BOT_TOKEN,
    IDLE_POLL_INTERVAL_SECONDS,
    PENDING_MEDIA_GROUP_POLL_INTERVAL_SECONDS,
    PUBLISH_JOB_CLAIM_LIMIT,
    TELEGRAM_ALLOWED_CHATS,
    TELEGRAM_OFFSET_POLL_ENABLED,
    THREADS_ACCESS_TOKEN,
    log,
)
from posting_core.clients.meta import crosspost_to_targets
from posting_core.clients.telegram import call_telegram
from posting_core.media import cleanup_temp_media, maybe_cleanup_media
from posting_core.queue import claim_due_publish_jobs, complete_publish_job, fail_publish_job, worker_id
from posting_core.state import load_state, save_state
from posting_core.text import strip_leading_emojis


def queued_media_to_items(media):
    if not media:
        return []
    raw_items = media if isinstance(media, list) else [media]
    items = []
    for item in raw_items:
        file_id = item.get("file_id")
        local_path = item.get("local_path") or item.get("path")
        media_type = item.get("type")
        if not file_id and not local_path:
            continue
        item_type = "VIDEO" if media_type in ("video", "VIDEO") else "IMAGE"
        normalized = {"type": item_type, "token": CONTROLLER_BOT_TOKEN}
        if file_id:
            normalized["file_id"] = file_id
        if local_path:
            normalized["local_path"] = local_path
        items.append(normalized)
    return items


def process_publish_queue(state):
    claimed = claim_due_publish_jobs(limit=PUBLISH_JOB_CLAIM_LIMIT, worker=worker_id("publisher"))
    if not claimed:
        return False
    changed = False
    jobs_by_message = {}
    for job in claimed:
        key = f"post:{job['post_id']}" if job.get("post_id") else f"message:{job['message_id']}"
        jobs_by_message.setdefault(key, []).append(job)

    for key, jobs in jobs_by_message.items():
        job = jobs[0]["payload"]
        try:
            post_id = jobs[0].get("post_id") or job.get("post_id")
            message_id = job.get("telegram_message_id") or job.get("message_id")
            chat_id = job.get("chat_id") or "queued"
            unique_id = f"post:{post_id}" if post_id else f"{chat_id}:{message_id}"
            text = strip_leading_emojis(job.get("text_ru") or job.get("text_en") or "")
            media_items = queued_media_to_items(job.get("media_ru"))
            if not text and not media_items:
                log(f"Queued publish job {key} has no text/media, dropping.")
                for claimed_job in jobs:
                    complete_publish_job(claimed_job["job_id"], {"ok": False, "skipped": True, "reason": "empty_text_and_media"})
                changed = True
                continue
            allowed_targets = {claimed_job["target"] for claimed_job in jobs}
            log(f"Processing queued publish jobs {post_id or message_id}: {', '.join(sorted(allowed_targets))}")
            result = crosspost_to_targets(
                text,
                media_items,
                message_id=message_id,
                post_id=post_id,
                allowed_targets=allowed_targets,
            )
            if result:
                if unique_id not in state.setdefault("processed_message_ids", []):
                    state["processed_message_ids"].append(unique_id)
                new_targets = result.get("targets", {})
                old_targets = state.setdefault("target_status", {}).get(unique_id) or {}
                merged = dict(old_targets)
                for t_name, t_rec in new_targets.items():
                    if t_rec.get("ok") or not merged.get(t_name, {}).get("ok"):
                        merged[t_name] = t_rec
                state.setdefault("target_status", {})[unique_id] = merged
                for claimed_job in jobs:
                    target_result = new_targets.get(claimed_job["target"])
                    if target_result is None:
                        fail_publish_job(claimed_job["job_id"], f"target {claimed_job['target']} did not return a result")
                    elif target_result.get("ok") or target_result.get("skipped"):
                        complete_publish_job(claimed_job["job_id"], target_result)
                    elif target_result.get("error"):
                        fail_publish_job(claimed_job["job_id"], target_result.get("error"))
                    else:
                        complete_publish_job(claimed_job["job_id"], target_result)
                changed = True
        except Exception as exc:
            log(f"Error processing queued publish job {key}: {exc}")
            for claimed_job in jobs:
                try:
                    fail_publish_job(claimed_job["job_id"], exc)
                except Exception as mark_exc:
                    log(f"Error marking queued publish job {key} failed: {mark_exc}")
    if changed:
        save_state(state)
    return changed


def advance_telegram_offset(state):
    last_update_id = int(state.get("last_update_id") or 0)
    updates = call_telegram("getUpdates", {"offset": last_update_id + 1, "timeout": 0})
    if not updates.get("ok"):
        log(f"Telegram returned error: {updates.get('description')}")
        return False
    for update in updates.get("result", []):
        last_update_id = max(last_update_id, update["update_id"])
    if state.get("last_update_id") != last_update_id:
        state["last_update_id"] = last_update_id
        save_state(state)
        return True
    return False


def main():
    if not THREADS_ACCESS_TOKEN:
        log("Warning: THREADS_ACCESS_TOKEN is missing; Threads targets will be skipped.")

    cleanup_temp_media()
    state = load_state()
    log("Telegram-to-Threads durable queue daemon started.")
    log(f"Allowed chats: {TELEGRAM_ALLOWED_CHATS or 'ALL'}")

    while True:
        try:
            state = load_state()
            maybe_cleanup_media()
            queue_changed = process_publish_queue(state)
            if TELEGRAM_OFFSET_POLL_ENABLED:
                advance_telegram_offset(state)
            sleep_for = PENDING_MEDIA_GROUP_POLL_INTERVAL_SECONDS if queue_changed else IDLE_POLL_INTERVAL_SECONDS
            time.sleep(sleep_for)
        except Exception as exc:
            log(f"Unexpected error in main loop: {exc}")
            time.sleep(10)


if __name__ == "__main__":
    main()
