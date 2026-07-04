from __future__ import annotations

import json
import urllib.parse

from posting_core.http_client import request, request_json
from posting_core.publish_config import MASTODON_INSTANCE, MASTODON_ACCESS_TOKEN, log


def _post_status(text: str, media_ids: list[str] | None = None, in_reply_to_id: str | None = None) -> tuple[str | None, str | None]:
    """Create a status on Mastodon, return (status_url, status_id)."""
    payload = {"status": text}
    if media_ids:
        payload["media_ids[]"] = media_ids  # type: ignore[assignment]
    if in_reply_to_id:
        payload["in_reply_to_id"] = in_reply_to_id

    # Mastodon uses form-encoded for simplicity
    encoded = urllib.parse.urlencode(
        {k: v for k, v in payload.items() if not isinstance(v, list)},
        doseq=False,
    ).encode()
    # Add media_ids as repeated params if present
    if media_ids:
        extra = "&".join(f"media_ids[]={mid}" for mid in media_ids)
        encoded = encoded + b"&" + extra.encode()

    url = f"https://{MASTODON_INSTANCE}/api/v1/statuses"
    resp = request(
        url,
        data=encoded,
        headers={
            "Authorization": f"Bearer {MASTODON_ACCESS_TOKEN}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
        timeout=30,
    )
    data = json.loads(resp.body)
    return data.get("url"), data.get("id")


def _upload_media(file_path: str) -> str | None:
    """Upload media attachment, return media ID."""
    import mimetypes
    mime_type, _ = mimetypes.guess_type(file_path)
    mime_type = mime_type or "image/jpeg"

    boundary = "----MastodonBoundary"
    with open(file_path, "rb") as f:
        file_data = f.read()

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="media"\r\n'
        f"Content-Type: {mime_type}\r\n\r\n"
    ).encode() + file_data + f"\r\n--{boundary}--\r\n".encode()

    url = f"https://{MASTODON_INSTANCE}/api/v2/media"
    resp = request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {MASTODON_ACCESS_TOKEN}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
        timeout=60,
    )
    data = json.loads(resp.body)
    return data.get("id")


def _status_split_limit() -> int:
    if not MASTODON_INSTANCE:
        return 480
    try:
        data = request_json(f"https://{MASTODON_INSTANCE}/api/v2/instance", timeout=15)
        statuses = ((data.get("configuration") or {}).get("statuses") or {})
        max_chars = int(statuses.get("max_characters") or 500)
        return max(1, max_chars - 20)
    except Exception as exc:
        log(f"Mastodon instance config fetch failed, using fallback split limit: {exc}")
        return 480


def publish_to_mastodon(text: str, media_items: list, canonical_url: str | None = None) -> dict:
    """Publish a toot or thread to Mastodon and return a normalized result."""
    if not MASTODON_INSTANCE or not MASTODON_ACCESS_TOKEN:
        log("Mastodon credentials missing, skipping")
        return {"ok": False, "skipped": True, "error": "missing_mastodon_credentials"}

    try:
        # Upload media (max 4 images on Mastodon)
        media_ids = []
        for item in media_items:
            if item.get("type") != "IMAGE":
                continue
            local_path = item.get("local_path")
            if not local_path:
                continue
            try:
                mid = _upload_media(local_path)
                if mid:
                    media_ids.append(mid)
                    log(f"Mastodon media uploaded: {mid}")
            except Exception as exc:
                log(f"Mastodon media upload failed: {exc}")
            if len(media_ids) >= 4:
                break

        # Mastodon limit: 500 chars (split cleanly on word boundaries)
        from posting_core.text import split_text
        parts = split_text(text, limit=_status_split_limit())

        first_url = None
        first_id = None
        last_id = None
        ids: list[str] = []
        urls: list[str] = []
        for i, part in enumerate(parts):
            # Only attach media to the first status
            current_media = media_ids if i == 0 else None
            url, post_id = _post_status(part, current_media, in_reply_to_id=last_id)
            if i == 0:
                first_url = url
                first_id = post_id
            last_id = post_id
            if post_id:
                ids.append(post_id)
            if url:
                urls.append(url)
            log(f"Mastodon status {i} published: {url} (ID: {post_id})")

        return {
            "ok": bool(first_url or first_id),
            "id": first_url or first_id,
            "url": first_url,
            "ids": ids,
            "urls": urls,
            "retryable": False,
        }

    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        log(f"Mastodon publish failed: {exc.code} {body}")
        return {"ok": False, "error": f"Mastodon API HTTP {exc.code}: {body}", "retryable": exc.code >= 500}
    except Exception as exc:
        log(f"Mastodon publish error: {exc}")
        return {"ok": False, "error": str(exc), "retryable": True}
