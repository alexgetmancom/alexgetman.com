from __future__ import annotations

import json
import time

from posting_core.publish_config import EN_TRANSLATION_POLL_SECONDS, EN_TRANSLATION_WAIT_SECONDS, FEED_JSON, log
from posting_core.queue import (
    load_publication_plan,
    load_publish_plan as load_durable_publish_plan,
    load_worker_state,
    save_worker_state,
)
from posting_core.text import strip_leading_emojis

def publish_plan_for_message(message_id, wait_seconds=10):
    if not message_id:
        return None
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            plan = load_durable_publish_plan(message_id)
            if isinstance(plan, dict) and plan:
                return plan
        except Exception as exc:
            log(f"Error reading publish plan for message {message_id}: {exc}")
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.5)


def publish_plan_for_post(post_id, wait_seconds=10):
    if not post_id:
        return None
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            plan = load_publication_plan(post_id)
            if isinstance(plan, dict) and plan:
                return plan
        except Exception as exc:
            log(f"Error reading publish plan for post {post_id}: {exc}")
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.5)


def plan_target_enabled(plan, target, default=True):
    if not plan:
        return default
    targets = plan.get("targets") if isinstance(plan, dict) else None
    if not isinstance(targets, dict):
        return default
    return bool(targets.get(target, False))


def load_english_translation(message_id):
    if not message_id:
        return None
    plan = publish_plan_for_message(message_id)
    if plan and plan.get("text_en"):
        return strip_leading_emojis(plan.get("text_en")).strip()
    try:
        if not FEED_JSON.exists():
            return None
        with FEED_JSON.open("r", encoding="utf-8") as fh:
            feed = json.load(fh)
        for item in feed.get("items", []):
            if str(item.get("message_id")) == str(message_id):
                text_en = item.get("text_en")
                if text_en:
                    return strip_leading_emojis(text_en).strip()
                return None
    except Exception as exc:
        log(f"Error reading English translation for message {message_id}: {exc}")
    return None


def wait_for_english_translation(message_id):
    if not message_id:
        log("No message_id for English crosspost lookup; EN targets will be skipped.")
        return None
    deadline = time.monotonic() + EN_TRANSLATION_WAIT_SECONDS
    while True:
        translated = load_english_translation(message_id)
        if translated:
            log(f"Loaded English translation for message {message_id}.")
            return translated
        if time.monotonic() >= deadline:
            log(f"English translation for message {message_id} not found after {EN_TRANSLATION_WAIT_SECONDS}s.")
            return None
        time.sleep(EN_TRANSLATION_POLL_SECONDS)


def load_state():
    try:
        state = load_worker_state("crosspost_worker", {"last_update_id": 0, "processed_message_ids": [], "target_status": {}})
        state.setdefault("processed_message_ids", [])
        state.setdefault("target_status", {})
        return state
    except Exception as exc:
        log(f"Error reading worker state: {exc}")
    return {"last_update_id": 0, "processed_message_ids": [], "target_status": {}}


def save_state(state):
    try:
        state["processed_message_ids"] = state["processed_message_ids"][-100:]
        if isinstance(state.get("target_status"), dict):
            keep = set(state["processed_message_ids"][-150:])
            state["target_status"] = {
                key: value for key, value in state["target_status"].items()
                if key in keep
            }
        save_worker_state("crosspost_worker", state)
    except Exception as exc:
        log(f"Error saving worker state to DB: {exc}")
