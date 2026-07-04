from __future__ import annotations

import json
import time
import urllib.parse

from posting_core.http_client import request_json
from posting_core.publish_config import (
    FACEBOOK_GRAPH_API_VERSION,
    INSTAGRAM_ACCESS_TOKEN,
    INSTAGRAM_GRAPH_API_VERSION,
    INSTAGRAM_USER_ID,
    log,
)


def _graph_base(access_token):
    if str(access_token or "").startswith("IG"):
        return f"https://graph.instagram.com/{INSTAGRAM_GRAPH_API_VERSION}"
    return f"https://graph.facebook.com/{FACEBOOK_GRAPH_API_VERSION}"


def _graph_post(path, payload, token=None):
    access_token = token or INSTAGRAM_ACCESS_TOKEN
    if not access_token:
        raise RuntimeError("missing INSTAGRAM_ACCESS_TOKEN")
    url = f"{_graph_base(access_token)}/{path.lstrip('/')}"
    return request_json(
        url,
        method="POST",
        data=urllib.parse.urlencode({**payload, "access_token": access_token}).encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=60,
    )


def _graph_get(path, fields, token=None):
    access_token = token or INSTAGRAM_ACCESS_TOKEN
    if not access_token:
        raise RuntimeError("missing INSTAGRAM_ACCESS_TOKEN")
    return request_json(
        f"{_graph_base(access_token)}/{path.lstrip('/')}",
        query={"fields": fields, "access_token": access_token},
        timeout=30,
    )


def _graph_get_query(path, query, token=None):
    access_token = token or INSTAGRAM_ACCESS_TOKEN
    if not access_token:
        raise RuntimeError("missing INSTAGRAM_ACCESS_TOKEN")
    return request_json(
        f"{_graph_base(access_token)}/{path.lstrip('/')}",
        query={**query, "access_token": access_token},
        timeout=30,
    )


def _wait_for_container(creation_id, token=None):
    for _ in range(12):
        status = _graph_get(creation_id, "status_code,status", token=token)
        status_code = status.get("status_code") or status.get("status")
        if status_code == "FINISHED":
            return status
        if status_code == "ERROR":
            raise RuntimeError(json.dumps(status, ensure_ascii=False))
        time.sleep(2)
    raise RuntimeError(f"instagram_container_timeout:{creation_id}")


def publish_instagram_story(media_items, caption=None, ig_user_id=None, token=None):
    target_user_id = ig_user_id or INSTAGRAM_USER_ID
    if not target_user_id:
        raise RuntimeError("missing INSTAGRAM_USER_ID")

    media_item = next((item for item in media_items or [] if item.get("story_vps_url") or item.get("vps_url") or item.get("public_url") or item.get("url")), None)
    if not media_item:
        return {"ok": False, "skipped": True, "reason": "missing_public_media_url"}

    public_url = media_item.get("story_vps_url") or media_item.get("vps_url") or media_item.get("public_url") or media_item.get("url")
    payload = {"media_type": "STORIES"}
    if media_item.get("type") == "VIDEO":
        payload["video_url"] = public_url
    else:
        payload["image_url"] = public_url
    if caption:
        payload["caption"] = caption[:2200]

    log("Creating Instagram Stories media container...")
    created = _graph_post(f"{target_user_id}/media", payload, token=token)
    creation_id = created.get("id")
    if not creation_id:
        return {"ok": False, "error": json.dumps(created, ensure_ascii=False)}
    _wait_for_container(creation_id, token=token)

    log("Publishing Instagram Story...")
    published = _graph_post(f"{target_user_id}/media_publish", {"creation_id": creation_id}, token=token)
    story_id = published.get("id")
    permalink = None
    if story_id:
        try:
            story = _graph_get(story_id, "permalink", token=token)
            permalink = story.get("permalink")
        except Exception as exc:
            log(f"Instagram Story permalink lookup failed: {exc}")
    result = {"ok": bool(story_id), "id": story_id, "raw": published}
    if permalink:
        result["url"] = permalink
    return result


def get_instagram_story_insights(media_id, token=None):
    metric_names = "views,reach,replies,shares,total_interactions,navigation"
    return _graph_get_query(f"{media_id}/insights", {"metric": metric_names}, token=token)


def get_instagram_media_fields(media_id, fields, token=None):
    return _graph_get(media_id, fields, token=token)
