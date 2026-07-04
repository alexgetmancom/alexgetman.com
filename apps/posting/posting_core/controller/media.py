from __future__ import annotations

import time
from pathlib import Path

from posting_core.clients.telegram import get_telegram_file_url
from posting_core.controller.config import BOT_TOKEN, DATA_DIR
from posting_core.http_client import request

STORY_WIDTH = 1080
STORY_HEIGHT = 1920
STORY_RATIO = STORY_WIDTH / STORY_HEIGHT
STORY_RATIO_TOLERANCE = 0.015


def parse_media(message):
    if 'photo' in message:
        photo = message['photo'][-1]
        return {
            'type': 'photo',
            'file_id': photo['file_id'],
            'width': photo.get('width'),
            'height': photo.get('height'),
        }
    if 'video' in message:
        video = message['video']
        return {
            'type': 'video',
            'file_id': video['file_id'],
            'width': video.get('width'),
            'height': video.get('height'),
            'duration': video.get('duration'),
        }
    return None


def normalize_media_list(media):
    if not media:
        return []
    return media if isinstance(media, list) else [media]


def media_payload_ref(item):
    return item.get('local_path') or item.get('path') or item['file_id']


def media_json_value(media):
    items = normalize_media_list(media)
    return items or None


def media_summary(media):
    items = normalize_media_list(media)
    if not items:
        return 'none'
    counts = {}
    for item in items:
        counts[item.get('type', 'media')] = counts.get(item.get('type', 'media'), 0) + 1
    parts = [f'{kind}:{count}' for kind, count in sorted(counts.items())]
    return f'{len(items)} item(s) ' + ', '.join(parts)


def _item_dimensions(item, story=False):
    if story:
        width = item.get('story_width')
        height = item.get('story_height')
        if width and height:
            return int(width), int(height)
    width = item.get('width')
    height = item.get('height')
    if width and height:
        return int(width), int(height)
    return None


def _ratio_label(width, height):
    return f'{width}x{height} ({width / height:.3f})'


def story_media_warnings(media):
    items = normalize_media_list(media)
    if not items:
        return ['Story media warning: no media attached; stories need photo/video media.']
    warnings = []
    for idx, item in enumerate(items, start=1):
        dims = _item_dimensions(item, story=bool(item.get('story_local_path') or item.get('story_vps_url')))
        if not dims:
            warnings.append(f'Story media warning #{idx}: dimensions unknown. Expected 9:16 / {STORY_WIDTH}x{STORY_HEIGHT}.')
            continue
        width, height = dims
        ratio = width / height
        if abs(ratio - STORY_RATIO) > STORY_RATIO_TOLERANCE:
            warnings.append(
                f'Story media warning #{idx}: {_ratio_label(width, height)}. '
                f'Expected 9:16 / {STORY_WIDTH}x{STORY_HEIGHT}; story may be cropped.'
            )
    return warnings


def story_media_status(media):
    warnings = story_media_warnings(media)
    if warnings:
        return '\n'.join(warnings)
    return f'Story media: 9:16 OK ({STORY_WIDTH}x{STORY_HEIGHT}).'


def _download_media_item(item, draft_id, locale):
    local_path = item.get('local_path') or item.get('path')
    if local_path:
        return Path(local_path)
    file_id = item.get('file_id')
    if not file_id:
        raise RuntimeError('Cannot generate story media without file_id or local_path')
    source = get_telegram_file_url(file_id, token=BOT_TOKEN)
    if not source:
        raise RuntimeError('Cannot resolve Telegram media file')
    if Path(str(source)).is_absolute():
        return Path(source)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_dir = DATA_DIR / 'story-media'
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = tmp_dir / f'draft-{draft_id}-{locale}-{int(time.time())}-source.jpg'
    tmp.write_bytes(request(source, timeout=60).body)
    return tmp


def generate_story_safe_media(media, draft_id, locale='ru'):
    items = normalize_media_list(media)
    if len(items) != 1:
        raise RuntimeError('Story-safe generation currently supports one media item')
    item = dict(items[0])
    if item.get('type') != 'photo':
        raise RuntimeError('Story-safe generation currently supports photo media')
    from PIL import Image, ImageOps

    source = _download_media_item(item, draft_id, locale)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    output_dir = DATA_DIR / 'story-media'
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / f'draft-{draft_id}-{locale}-story-{int(time.time())}.jpg'

    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image).convert('RGB')
        fitted = ImageOps.contain(image, (STORY_WIDTH, STORY_HEIGHT))
        canvas = Image.new('RGB', (STORY_WIDTH, STORY_HEIGHT), (0, 0, 0))
        x = (STORY_WIDTH - fitted.width) // 2
        y = (STORY_HEIGHT - fitted.height) // 2
        canvas.paste(fitted, (x, y))
        canvas.save(output, 'JPEG', quality=92, optimize=True)

    item['story_local_path'] = str(output)
    item['story_width'] = STORY_WIDTH
    item['story_height'] = STORY_HEIGHT
    return [item]


def media_format_key(media):
    items = normalize_media_list(media)
    if not items:
        return 'text_only'
    kinds = [item.get('type', 'media') for item in items]
    image_count = sum(1 for kind in kinds if kind == 'photo')
    video_count = sum(1 for kind in kinds if kind == 'video')
    if len(items) == 1 and image_count == 1:
        return 'single_image'
    if len(items) == 1 and video_count == 1:
        return 'single_video'
    if image_count == len(items):
        return 'image_album'
    if video_count == len(items):
        return 'video_album'
    return 'mixed_media'


def media_group_payload(media_items, caption, entities=None):
    payload = []
    for idx, item in enumerate(media_items):
        media_type = 'photo' if item['type'] == 'photo' else 'video'
        entry = {
            'type': media_type,
            'media': media_payload_ref(item),
        }
        if idx == 0 and caption:
            entry['caption'] = caption
            if entities:
                entry['caption_entities'] = entities
        payload.append(entry)
    return payload
