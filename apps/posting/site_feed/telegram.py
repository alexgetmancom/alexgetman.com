from __future__ import annotations

import html
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from posting_core.clients.telegram import call_telegram, get_telegram_file_url
from posting_core.http_client import request
from posting_core.text import clean_text
from posting_core.time_utils import now_iso
from site_feed.config import (
    CHANNEL_USERNAME,
    PUBLIC_BASE_URL,
    PUBLIC_MEDIA_DIR,
    SOURCE_MEDIA_DIR,
    WEBHOOK_PATH,
    log,
    require_env,
)
def iso_from_unix(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).replace(microsecond=0).isoformat()


def download_media(url, message_id, suffix, index=0):
    if not url:
        return None
    try:
        SOURCE_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        PUBLIC_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        
        suffix = re.sub(r"[^a-zA-Z0-9]", "", suffix or "bin")[:8] or "bin"
        target_name = f"{message_id}.{suffix}" if int(index or 0) == 0 else f"{message_id}-{int(index)}.{suffix}"
        source_path = SOURCE_MEDIA_DIR / target_name
        public_path = PUBLIC_MEDIA_DIR / target_name
        
        if os.path.isabs(str(url)):
            local_source = Path(url)
            if not local_source.exists():
                raise FileNotFoundError(str(local_source))
            shutil.copy2(local_source, source_path)
            shutil.copy2(local_source, public_path)
        else:
            data = request(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
                timeout=30,
            ).body
            source_path.write_bytes(data)
            public_path.write_bytes(data)
        source_path.chmod(0o664)
        public_path.chmod(0o664)
        log(f"Media сохранено для поста {message_id}: media/{target_name}")
        return f"media/{target_name}"
    except Exception as exc:
        log(f"Ошибка скачивания media {url}: {exc}")
    return None


def download_image(url, message_id):
    return download_media(url, message_id, "jpg")


def media_suffix(file_id, media_type):
    if str(media_type).lower() == "video":
        return "mp4"
    return "jpg"


def download_telegram_media(file_id, message_id, media_type, index=0, token=None):
    url = get_telegram_file_url(file_id, token=token)
    if not url:
        return None
    return download_media(url, message_id, media_suffix(file_id, media_type), index=index)


def apply_entities(text, entities):
    if not text:
        return ""
    if not entities:
        return text_to_html(text)
        
    try:
        sorted_entities = sorted(entities, key=lambda x: x.get("offset", 0), reverse=True)
        encoded = text.encode("utf-16-le")
        
        for ent in sorted_entities:
            ent_type = ent.get("type")
            if ent_type not in ("url", "text_link"):
                continue
                
            offset = ent.get("offset", 0)
            length = ent.get("length", 0)
            
            start = offset * 2
            end = (offset + length) * 2
            
            ent_text = encoded[start:end].decode("utf-16-le")
            
            if ent_type == "text_link":
                url = ent.get("url", "")
            else:
                url = ent_text
                
            if not url:
                continue
                
            markdown_str = f"[{ent_text}]({url})"
            encoded = encoded[:start] + markdown_str.encode("utf-16-le") + encoded[end:]
            
        text = encoded.decode("utf-16-le")
    except Exception as exc:
        log(f"Ошибка apply_entities: {exc}")
        
    return text_to_html(text)


def linkify(escaped):
    placeholders = []
    def save_link(match):
        placeholders.append(match.group(0))
        return f"___LINK_PLACEHOLDER_{len(placeholders)-1}___"
        
    temp_text = re.sub(r'<a\s+[^>]*>.*?</a>', save_link, escaped, flags=re.S)
    
    pattern = re.compile(r"(https?://[^\s<]+)")
    temp_text = pattern.sub(r'<a href="\1" target="_blank" rel="noopener">\1</a>', temp_text)
    
    for i, placeholder_content in enumerate(placeholders):
        temp_text = temp_text.replace(f"___LINK_PLACEHOLDER_{i}___", placeholder_content)
        
    return temp_text


def text_to_html(text):
    escaped = html.escape(clean_text(text))
    markdown_pattern = re.compile(r"\[([^\]]+)\]\((https?://[^\s\)]+)\)")
    html_text = markdown_pattern.sub(r'<a href="\2" target="_blank" rel="noopener">\1</a>', escaped)
    return linkify(html_text).replace("\n", "<br>")


def message_to_item(message, edited=False):
    message_id = message.get("message_id")
    text = clean_text(message.get("text") or message.get("caption") or "")
    if not message_id:
        return None
        
    photo = message.get("photo")
    if not text and not photo:
        return None

    image_path = None
    if photo:
        file_id = photo[-1]["file_id"]
        file_url = get_telegram_file_url(file_id)
        if file_url:
            image_path = download_image(file_url, message_id)

    entities = message.get("entities") or message.get("caption_entities") or []

    return {
        "id": f"telegram:{CHANNEL_USERNAME}:{message_id}",
        "source": "telegram",
        "message_id": message_id,
        "date": iso_from_unix(message.get("date", datetime.now(timezone.utc).timestamp())),
        "url": f"https://t.me/{CHANNEL_USERNAME}/{message_id}",
        "text": text,
        "html": apply_entities(text, entities),
        "image": image_path,
        "edited": bool(edited),
        "received_at": now_iso(),
    }








def set_webhook():
    secret = require_env("TELEGRAM_WEBHOOK_SECRET")
    token = os.environ.get("CONTROLLER_BOT_TOKEN") or require_env("TELEGRAM_BOT_TOKEN")
    payload = {
        "url": PUBLIC_BASE_URL + WEBHOOK_PATH,
        "allowed_updates": ["channel_post", "edited_channel_post"],
        "secret_token": secret,
        "drop_pending_updates": False,
    }
    result = call_telegram("setWebhook", payload, token=token)
    if not result.get("ok"):
        raise SystemExit(f"Telegram setWebhook failed: {result}")
    log("Telegram webhook установлен")


def webhook_info():
    token = os.environ.get("CONTROLLER_BOT_TOKEN") or require_env("TELEGRAM_BOT_TOKEN")
    result = call_telegram("getWebhookInfo", token=token)
    safe = result.copy()
    if isinstance(safe.get("result"), dict) and safe["result"].get("url"):
        safe["result"]["url"] = safe["result"]["url"].replace(PUBLIC_BASE_URL, PUBLIC_BASE_URL)
    print(json.dumps(safe, ensure_ascii=False, indent=2))
