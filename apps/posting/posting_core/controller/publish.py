from __future__ import annotations

import json
import os

from posting_core.controller.config import CHANNEL_ID, api, api_upload
from posting_core.controller.db import update_draft
from posting_core.controller.media import media_group_payload, media_payload_ref, normalize_media_list
from posting_core.controller.ui import media_for, targets_for
from posting_core.content import parse_entities
from posting_core.publications import post_key, sync_publication_from_draft
from posting_core.queue import enqueue_publication
from posting_core.targets import SOCIAL_TARGET_IDS, TARGET_BY_ID
from posting_core.time_utils import now_iso
from posting_core.controller.db import db


def publish_report(post_id):
    key = post_key(post_id)
    with db() as conn:
        targets = conn.execute(
            "SELECT target, status, url, error, skipped FROM post_targets WHERE post_key=? ORDER BY target",
            (key,),
        ).fetchall()
        jobs = conn.execute(
            "SELECT target, status, last_error FROM publish_jobs WHERE post_id=? ORDER BY target",
            (post_id,),
        ).fetchall()
    lines = [f"Publish report for post #{post_id}:"]
    for row in targets:
        suffix = ""
        if row["url"]:
            suffix = f" {row['url']}"
        elif row["error"]:
            suffix = f" error={row['error']}"
        lines.append(f"- {row['target']}: {row['status']}{suffix}")
    known = {row["target"] for row in targets}
    for row in jobs:
        if row["target"] in known:
            continue
        suffix = f" error={row['last_error']}" if row["last_error"] else ""
        lines.append(f"- {row['target']}: {row['status']}{suffix}")
    return "\n".join(lines)


def publish_to_channel(draft, publish_at_en=None, publish_now=True):
    targets = targets_for(draft)
    text_ru = draft['text_ru']
    media = media_for(draft, 'ru')
    media_items = normalize_media_list(media)
    msg = None
    if targets.get('telegram') and draft.get('channel_message_id'):
        msg = {
            'message_id': int(draft['channel_message_id']),
            'chat': {'id': CHANNEL_ID},
        }
    elif targets.get('telegram'):
        entities = parse_entities(draft.get("text_ru_entities_json"))
        if len(media_items) > 1:
            res = api('sendMediaGroup', {'chat_id': CHANNEL_ID, 'media': media_group_payload(media_items, text_ru, entities)})
        elif len(media_items) == 1 and media_items[0]['type'] == 'photo':
            media_ref = media_payload_ref(media_items[0])
            payload = {'chat_id': CHANNEL_ID, 'photo': media_ref}
            if text_ru:
                payload['caption'] = text_ru
            if entities:
                payload['caption_entities'] = entities
            if os.path.isabs(str(media_ref)):
                payload.pop('photo')
                res = api_upload('sendPhoto', payload, 'photo', media_ref)
            else:
                res = api('sendPhoto', payload)
        elif len(media_items) == 1 and media_items[0]['type'] == 'video':
            media_ref = media_payload_ref(media_items[0])
            payload = {'chat_id': CHANNEL_ID, 'video': media_ref}
            if text_ru:
                payload['caption'] = text_ru
            if entities:
                payload['caption_entities'] = entities
            if os.path.isabs(str(media_ref)):
                payload.pop('video')
                res = api_upload('sendVideo', payload, 'video', media_ref)
            else:
                res = api('sendVideo', payload)
        else:
            if not text_ru:
                raise RuntimeError('Text or media is required')
            payload = {'chat_id': CHANNEL_ID, 'text': text_ru, 'disable_web_page_preview': False}
            if entities:
                payload['entities'] = entities
            res = api('sendMessage', payload)
        if not res.get('ok'):
            raise RuntimeError(str(res))
        msg = res['result']
        if isinstance(msg, list):
            msg = msg[0]
        update_draft(draft['id'], channel_message_id=msg['message_id'])
    message_id = msg['message_id'] if msg else None
    post_id = sync_publication_from_draft(draft, targets)
    published_at = now_iso()
    has_ru_targets = any(
        enabled and TARGET_BY_ID.get(target_id) and TARGET_BY_ID[target_id].locale == 'ru'
        for target_id, enabled in targets.items()
    )
    has_en_targets = any(
        enabled and TARGET_BY_ID.get(target_id) and TARGET_BY_ID[target_id].locale == 'en'
        for target_id, enabled in targets.items()
    )
    if publish_now:
        scheduled_at = published_at if has_ru_targets else None
        scheduled_en_at = published_at if has_en_targets else None
        publish_mode = 'immediate'
    else:
        scheduled_at = draft.get('scheduled_at')
        scheduled_en_at = publish_at_en
        publish_mode = 'scheduled'
    plan = {
        'draft_id': draft['id'],
        'post_id': post_id,
        'targets': targets,
        'text_en': draft.get('text_en_approved') or draft.get('text_en_machine') or '',
        'media_en': json.loads(draft['media_en_json']) if draft.get('media_en_json') else None,
        'created_at': now_iso(),
        'scheduled_at': scheduled_at,
        'scheduled_en_at': scheduled_en_at,
    }
    job = {
        'draft_id': draft['id'],
        'post_id': post_id,
        'chat_id': msg.get('chat', {}).get('id') if msg else None,
        'telegram_message_id': message_id,
        'text_ru': text_ru,
        'text_en': draft.get('text_en_approved') or draft.get('text_en_machine') or '',
        'media_ru': json.loads(draft['media_ru_json']) if draft.get('media_ru_json') else None,
        'created_at': now_iso(),
        'publish_at_ru': scheduled_at,
        'publish_at_en': scheduled_en_at,
    }
    source_item = {
        'draft_id': draft['id'],
        'post_id': post_id,
        'chat_id': msg.get('chat', {}).get('id') if msg else None,
        'telegram_message_id': message_id,
        'telegram_url': (
            f'https://t.me/{str(CHANNEL_ID).lstrip("@")}/{message_id}'
            if message_id and str(CHANNEL_ID).startswith('@')
            else None
        ),
        'date': now_iso(),
        'text_ru': text_ru,
        'text_en': draft.get('text_en_approved') or draft.get('text_en_machine') or '',
        'media_ru': json.loads(draft['media_ru_json']) if draft.get('media_ru_json') else None,
        'media_en': json.loads(draft['media_en_json']) if draft.get('media_en_json') else None,
        'targets': targets,
        'created_at': now_iso(),
        'publish_at_ru': scheduled_at,
        'publish_at_en': scheduled_en_at,
    }
    migrated_targets = set()
    publish_at_by_target = {
        target_id: scheduled_en_at
        for target_id, enabled in targets.items()
        if enabled
        and target_id not in migrated_targets
        and TARGET_BY_ID.get(target_id)
        and TARGET_BY_ID[target_id].locale == 'en'
    } if scheduled_en_at else {}
    enqueue_targets = {
        target_id: True
        for target_id in SOCIAL_TARGET_IDS
        if targets.get(target_id) and target_id not in migrated_targets
    }
    enqueue_publication(
        post_id,
        plan,
        job,
        source_item,
        publish_at_by_target=publish_at_by_target,
        enqueue_targets=enqueue_targets,
    )
    update_draft(
        draft['id'],
        status='published',
        channel_message_id=message_id,
        scheduled_at=scheduled_at,
        scheduled_en_at=scheduled_en_at,
        publish_mode=publish_mode,
        post_id=post_id,
    )
    with db() as conn:
        conn.execute(
            """
            UPDATE publications
            SET status='published', telegram_message_id=?, updated_at=?
            WHERE post_id=?
            """,
            (message_id, published_at, post_id),
        )
        if message_id:
            conn.execute(
                """
                INSERT INTO post_targets(post_key, target, status, external_id, url, updated_at)
                VALUES (?, 'telegram', 'published', ?, ?, ?)
                ON CONFLICT(post_key, target) DO UPDATE SET
                    status='published',
                    external_id=excluded.external_id,
                    url=excluded.url,
                    updated_at=excluded.updated_at
                """,
                (
                    post_key(post_id),
                    str(message_id),
                    f'https://t.me/{str(CHANNEL_ID).lstrip("@")}/{message_id}',
                    published_at,
                ),
            )
        conn.commit()
    return post_id
