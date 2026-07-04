from __future__ import annotations

import json
import mimetypes
import os
import re
import sqlite3
import uuid
import asyncio
from pathlib import Path

from posting_core.http_client import request_json
from posting_core.publish_config import (
    ENABLE_TELEGRAM_STORIES,
    PUBLIC_SITE_BASE_URL,
    TELEGRAM_CHANNEL_STORIES_API_HASH,
    TELEGRAM_CHANNEL_STORIES_API_ID,
    TELEGRAM_CHANNEL_STORIES_SESSION,
    TELEGRAM_API_BASE_URL,
    TELEGRAM_STORIES_BOT_TOKEN,
    TELEGRAM_STORIES_BUSINESS_CONNECTION_ID,
)

URL_RE = re.compile(r"https?://[^\s<>)]+")


def _multipart_body(fields, files):
    boundary = f"----alexgetman{uuid.uuid4().hex}"
    chunks = []
    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            str(value).encode(),
            b"\r\n",
        ])
    for name, path in files.items():
        file_path = Path(path)
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"; filename="{file_path.name}"\r\n'.encode(),
            f"Content-Type: {content_type}\r\n\r\n".encode(),
            file_path.read_bytes(),
            b"\r\n",
        ])
    chunks.append(f"--{boundary}--\r\n".encode())
    return boundary, b"".join(chunks)


def _post_story_multipart(payload, upload_path):
    if not TELEGRAM_STORIES_BOT_TOKEN:
        raise RuntimeError("missing TELEGRAM_STORIES_BOT_TOKEN")
    boundary, body = _multipart_body(payload, {"story": upload_path})
    return request_json(
        f"{TELEGRAM_API_BASE_URL}/bot{TELEGRAM_STORIES_BOT_TOKEN}/postStory",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
        timeout=60,
    )


def _business_connection_id():
    if TELEGRAM_STORIES_BUSINESS_CONNECTION_ID:
        return TELEGRAM_STORIES_BUSINESS_CONNECTION_ID
    db_path = Path(os.environ.get("PIPELINE_DB", "/data/pipeline.db"))
    if not db_path.exists():
        return None
    try:
        with sqlite3.connect(str(db_path), timeout=2) as conn:
            row = conn.execute(
                "SELECT state_json FROM worker_state WHERE name='telegram_business_connection'"
            ).fetchone()
        if not row:
            return None
        state = json.loads(row[0] or "{}")
        if state.get("is_enabled") is False:
            return None
        return state.get("business_connection_id")
    except Exception:
        return None


def _story_link_area(url):
    return {
        "position": {
            "x_percentage": 50,
            "y_percentage": 85,
            "width_percentage": 80,
            "height_percentage": 12,
            "rotation_angle": 0,
            "corner_radius_percentage": 4,
        },
        "type": {"type": "link", "url": url},
    }


def _channel_story_url(story_id):
    channel = os.environ.get("CHANNEL_USERNAME", "alexgetmancom").lstrip("@")
    return f"https://t.me/{channel}/s/{story_id}"


async def _publish_channel_story(media_item, caption=None, link_url=None):
    from telethon import TelegramClient, functions, types

    channel = os.environ.get("CHANNEL_USERNAME", "alexgetmancom").lstrip("@")
    client = TelegramClient(
        TELEGRAM_CHANNEL_STORIES_SESSION,
        int(TELEGRAM_CHANNEL_STORIES_API_ID),
        TELEGRAM_CHANNEL_STORIES_API_HASH,
    )
    await client.connect()
    try:
        peer = await client.get_input_entity(channel)
        upload_path = media_item.get("story_local_path") or media_item.get("local_path")
        uploaded = await client.upload_file(upload_path)
        media_type = str(media_item.get("type") or "").lower()
        if media_type == "video":
            media = types.InputMediaUploadedDocument(
                file=uploaded,
                mime_type=mimetypes.guess_type(upload_path)[0] or "video/mp4",
                attributes=[],
            )
        else:
            media = types.InputMediaUploadedPhoto(file=uploaded)
        media_areas = None
        if link_url:
            media_areas = [
                types.MediaAreaUrl(
                    coordinates=types.MediaAreaCoordinates(
                        x=50.0,
                        y=86.0,
                        w=82.0,
                        h=12.0,
                        rotation=0.0,
                        radius=4.0,
                    ),
                    url=link_url,
                )
            ]
        result = await client(
            functions.stories.SendStoryRequest(
                peer=peer,
                media=media,
                privacy_rules=[types.InputPrivacyValueAllowAll()],
                media_areas=media_areas,
                caption=str(caption or "")[:2048] or None,
                random_id=uuid.uuid4().int & ((1 << 63) - 1),
                period=86400,
            )
        )
        story_id = None
        for update in getattr(result, "updates", []) or []:
            if isinstance(update, types.UpdateStoryID):
                story_id = update.id
                break
        if not story_id:
            raise RuntimeError("telegram_channel_story_missing_story_id")
        return {
            "ok": True,
            "id": story_id,
            "url": _channel_story_url(story_id),
            "raw": {
                "ok": True,
                "id": story_id,
                "peer": channel,
                "source": "telethon_stories.sendStory",
                "link": link_url,
            },
        }
    finally:
        await client.disconnect()


def publish_telegram_story(media_items, caption=None, link_url=None):
    media_item = next((item for item in media_items or [] if item.get("local_path")), None)
    if not media_item:
        return {"ok": False, "skipped": True, "reason": "missing_media"}
    if not link_url:
        caption_text = str(caption or "")
        match = URL_RE.search(caption_text)
        link_url = match.group(0) if match else None
    if not link_url:
        link_url = PUBLIC_SITE_BASE_URL

    if TELEGRAM_CHANNEL_STORIES_API_ID and TELEGRAM_CHANNEL_STORIES_API_HASH:
        return asyncio.run(_publish_channel_story(media_item, caption=caption, link_url=link_url))

    if not ENABLE_TELEGRAM_STORIES:
        return {"ok": False, "skipped": True, "reason": "telegram_stories_disabled"}
    business_connection_id = _business_connection_id()
    if not business_connection_id:
        return {"ok": False, "skipped": True, "reason": "missing_business_connection_id"}
    if media_item.get("type") == "VIDEO":
        return {"ok": False, "skipped": True, "reason": "telegram_story_video_requires_h265_profile"}

    payload = {
        "business_connection_id": business_connection_id,
        "active_period": 86400,
        "content": json.dumps({"type": "photo", "photo": "attach://story"}, ensure_ascii=False),
    }
    if caption:
        caption_text = str(caption)[:2048]
        payload["caption"] = caption_text
    if link_url:
        payload["areas"] = json.dumps([_story_link_area(link_url)], ensure_ascii=False)

    result = _post_story_multipart(payload, media_item["local_path"])
    story = result.get("result") if isinstance(result, dict) else None
    story_id = story.get("id") if isinstance(story, dict) else None
    return {"ok": bool(result.get("ok")), "id": story_id, "raw": result}
