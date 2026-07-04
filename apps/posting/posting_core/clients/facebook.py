from __future__ import annotations

from posting_core.http_client import HttpRequestError, request_json
from posting_core.publish_config import FACEBOOK_GRAPH_API_VERSION, FACEBOOK_PAGE_ACCESS_TOKEN, FACEBOOK_PAGE_ID, json, log
from posting_core.text import strip_leading_emojis


def call_facebook(endpoint, payload, method="POST", is_video=False, token=None):
    base_url = "https://graph-video.facebook.com" if is_video else "https://graph.facebook.com"
    url = f"{base_url}/{FACEBOOK_GRAPH_API_VERSION}/{endpoint}"
    payload["access_token"] = token or FACEBOOK_PAGE_ACCESS_TOKEN

    headers = {"Content-Type": "application/json"}
    try:
        return request_json(url, method=method, payload=payload, headers=headers, timeout=60)
    except HttpRequestError as err:
        log(f"HTTPError in call_facebook: {err.status} {err.reason}. Response body: {err.body}")
        raise Exception(f"Facebook API HTTP {err.status}: {err.body}")


def publish_to_facebook(text, media_items, page_id=None, token=None):
    target_page_id = page_id or FACEBOOK_PAGE_ID
    target_token = token or FACEBOOK_PAGE_ACCESS_TOKEN
    if not target_token or not target_page_id:
        return None

    log(f"Publishing to Facebook Page {target_page_id}...")
    text = strip_leading_emojis(text)
    try:
        if len(media_items) > 0:
            has_video = any(item["type"] == "VIDEO" for item in media_items)
            if has_video:
                video_item = next(item for item in media_items if item["type"] == "VIDEO")
                payload = {
                    "file_url": video_item["vps_url"],
                    "description": text,
                }
                res = call_facebook(f"{target_page_id}/videos", payload, is_video=True, token=target_token)
                log(f"Facebook video published: {res.get('id')}")
                return res.get("id")
            photo_ids = []
            for item in media_items:
                photo_payload = {
                    "url": item["vps_url"],
                    "published": False,
                }
                photo_res = call_facebook(f"{target_page_id}/photos", photo_payload, token=target_token)
                photo_ids.append(photo_res["id"])

            attached_media = [{"media_fbid": pid} for pid in photo_ids]
            feed_payload = {
                "message": text,
                "attached_media": json.dumps(attached_media),
            }
            res = call_facebook(f"{target_page_id}/feed", feed_payload, token=target_token)
            log(f"Facebook multi-photo post published: {res.get('id')}")
            return res.get("id")
        feed_payload = {"message": text}
        res = call_facebook(f"{target_page_id}/feed", feed_payload, token=target_token)
        log(f"Facebook text post published: {res.get('id')}")
        return res.get("id")

    except Exception as exc:
        log(f"Error publishing to Facebook: {exc}")
        return None
