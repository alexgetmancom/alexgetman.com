from __future__ import annotations

import json

from posting_core.controller.config import ADMIN_IDS, TEST_PLAN_TEXT, api, log
from posting_core.controller.albums import append_pending_album
from posting_core.controller.db import db, get_draft, get_scheduled_drafts, get_state, set_state, update_draft
from posting_core.controller.drafts import create_draft
from posting_core.controller.limits import DraftTextTooLong, validate_draft_text
from posting_core.controller.media import generate_story_safe_media, media_json_value, parse_media
from posting_core.controller.publish import publish_report, publish_to_channel
from posting_core.controller.schedule import (
    cancel_scheduled_draft,
    rebalance_all_scheduled_drafts,
    schedule_draft,
    schedule_draft_at,
    parse_manual_schedule,
    preset_schedule_time,
    schedule_summary,
)
from posting_core.time_utils import now_iso
from posting_core.controller.translation import translate_ru_to_en
from posting_core.controller.ui import (
    answer_callback,
    apply_preset,
    schedule_keyboard,
    schedule_choice_keyboard,
    media_for,
    send_preview,
    targets_for,
    toggle_target,
)
from posting_core.targets import TARGET_BY_ID


def _message_entities(message):
    return message.get('entities') or message.get('caption_entities') or []


def send_schedule(chat_id):
    drafts = get_scheduled_drafts()
    if not drafts:
        api('sendMessage', {'chat_id': chat_id, 'text': 'Schedule is empty.'})
        return
    api(
        'sendMessage',
        {
            'chat_id': chat_id,
            'text': 'Scheduled publications. Open any item to edit it before publication.',
            'reply_markup': schedule_keyboard(drafts),
        },
    )


def handle_business_connection(connection):
    connection_id = connection.get('id')
    if not connection_id:
        log('business_connection update without id')
        return
    user = connection.get('user') or {}
    state = {
        'business_connection_id': connection_id,
        'user_id': user.get('id'),
        'username': user.get('username'),
        'is_enabled': connection.get('is_enabled'),
    }
    with db() as conn:
        conn.execute(
            """
            INSERT INTO worker_state(name, state_json, updated_at)
            VALUES ('telegram_business_connection', ?, ?)
            ON CONFLICT(name) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at
            """,
            (json.dumps(state, ensure_ascii=False), now_iso()),
        )
        conn.commit()
    log(f"telegram business connection updated: id={connection_id} enabled={connection.get('is_enabled')}")


def handle_message(message):
    user = message.get('from') or {}
    admin_id = int(user.get('id') or 0)
    chat_id = message['chat']['id']
    if admin_id not in ADMIN_IDS:
        api('sendMessage', {'chat_id': chat_id, 'text': 'Forbidden'})
        return
    text = message.get('text') or message.get('caption') or ''
    state = get_state(admin_id)
    if text == '/start':
        set_state(admin_id)
        api(
            'sendMessage',
            {
                'chat_id': chat_id,
                'text': 'Send draft text with optional photo/video/album.',
                'reply_markup': {
                    'inline_keyboard': [
                        [{'text': 'Schedule', 'callback_data': 'schedule_list'}],
                    ]
                },
            },
        )
        return
    if text in {'/schedule', '/scheduled'}:
        send_schedule(chat_id)
        return
    if text == '/testplan':
        api('sendMessage', {'chat_id': chat_id, 'text': TEST_PLAN_TEXT})
        return
    if (state.get('action') or '').startswith('schedule_manual_') and text:
        scope = state['action'].replace('schedule_manual_', '', 1)
        try:
            value = parse_manual_schedule(text)
            result = schedule_draft_at(
                state['draft_id'],
                scheduled_at=value if scope in {'both', 'ru'} else None,
                scheduled_en_at=value if scope in {'both', 'en'} else None,
            )
        except Exception as exc:
            api('sendMessage', {'chat_id': chat_id, 'text': f'Cannot schedule: {exc}'})
            return
        set_state(admin_id)
        api('sendMessage', {'chat_id': chat_id, 'text': f'Draft #{state["draft_id"]} scheduled.\n{schedule_summary(result)}'})
        send_preview(chat_id, state['draft_id'])
        return
    if state.get('action') in {'edit_ru', 'edit_en'} and text:
        locale = 'RU' if state['action'] == 'edit_ru' else 'EN'
        try:
            validate_draft_text(text, locale)
        except DraftTextTooLong as exc:
            api('sendMessage', {'chat_id': chat_id, 'text': exc.message()})
            return
        if state['action'] == 'edit_ru':
            update_draft(
                state['draft_id'],
                text_ru=text,
                text_ru_entities_json=json.dumps(_message_entities(message), ensure_ascii=False),
            )
        else:
            update_draft(
                state['draft_id'],
                text_en_approved=text,
                text_en_entities_json=json.dumps(_message_entities(message), ensure_ascii=False),
            )
        if (get_draft(state['draft_id']) or {}).get('status') == 'scheduled':
            rebalance_all_scheduled_drafts()
        set_state(admin_id)
        send_preview(chat_id, state['draft_id'])
        return
    if state.get('action') in {'replace_ru_media', 'replace_en_media'}:
        media = parse_media(message)
        if not media:
            api('sendMessage', {'chat_id': chat_id, 'text': 'Send photo, video, or album for replacement media.'})
            return
        if message.get('media_group_id'):
            append_pending_album(admin_id, chat_id, message['media_group_id'], '', media, action=state['action'], draft_id=state['draft_id'])
            return
        field = 'media_ru_json' if state['action'] == 'replace_ru_media' else 'media_en_json'
        update_draft(state['draft_id'], **{field: json.dumps(media_json_value(media), ensure_ascii=False)})
        if (get_draft(state['draft_id']) or {}).get('status') == 'scheduled':
            rebalance_all_scheduled_drafts()
        set_state(admin_id)
        send_preview(chat_id, state['draft_id'])
        return
    if message.get('media_group_id') and parse_media(message):
        try:
            validate_draft_text(text, "RU")
        except DraftTextTooLong as exc:
            api('sendMessage', {'chat_id': chat_id, 'text': exc.message()})
            return
        append_pending_album(
            admin_id,
            chat_id,
            message['media_group_id'],
            text,
            parse_media(message),
            entities=_message_entities(message),
        )
        return
    if not text and not parse_media(message):
        api('sendMessage', {'chat_id': chat_id, 'text': 'Send text, photo caption, or video caption.'})
        return
    try:
        draft_id = create_draft(admin_id, text, parse_media(message), _message_entities(message))
    except DraftTextTooLong as exc:
        api('sendMessage', {'chat_id': chat_id, 'text': exc.message()})
        return
    send_preview(chat_id, draft_id)


def handle_callback(callback):
    data = callback.get('data') or ''
    user_id = int((callback.get('from') or {}).get('id') or 0)
    chat_id = callback['message']['chat']['id']
    if user_id not in ADMIN_IDS:
        answer_callback(callback['id'], 'Forbidden')
        return
    parts = data.split(':')
    action = parts[0]
    try:
        if action == 'schedule_list':
            answer_callback(callback['id'])
            send_schedule(chat_id)
        elif action == 'schedule_open':
            answer_callback(callback['id'])
            send_preview(chat_id, int(parts[1]))
        elif action == 'preset':
            apply_preset(int(parts[2]), parts[1])
            if (get_draft(int(parts[2])) or {}).get('status') == 'scheduled':
                rebalance_all_scheduled_drafts()
            answer_callback(callback['id'])
            send_preview(chat_id, int(parts[2]))
        elif action == 'toggle':
            toggle_target(int(parts[2]), parts[1])
            if (get_draft(int(parts[2])) or {}).get('status') == 'scheduled':
                rebalance_all_scheduled_drafts()
            answer_callback(callback['id'])
            send_preview(chat_id, int(parts[2]))
        elif action in {'edit_ru', 'edit_en'}:
            set_state(user_id, action, int(parts[1]))
            locale = 'RU' if action == 'edit_ru' else 'EN'
            answer_callback(callback['id'], f'Send edited {locale} text')
            api('sendMessage', {'chat_id': chat_id, 'text': f'Send edited {locale} text as the next message.'})
        elif action == 'regen_en':
            draft = get_draft(int(parts[1]))
            en = translate_ru_to_en(draft['text_ru'])
            update_draft(draft['id'], text_en_machine=en, text_en_approved=en)
            if draft.get('status') == 'scheduled':
                rebalance_all_scheduled_drafts()
            answer_callback(callback['id'], 'Regenerated')
            send_preview(chat_id, draft['id'])
        elif action in {'replace_ru_media', 'replace_en_media'}:
            set_state(user_id, action, int(parts[1]))
            locale = 'RU' if action == 'replace_ru_media' else 'EN'
            answer_callback(callback['id'], f'Send {locale} media')
            api('sendMessage', {'chat_id': chat_id, 'text': f'Send {locale} photo/video as the next message.'})
        elif action in {'generate_story_ru', 'generate_story_en'}:
            draft = get_draft(int(parts[1]))
            locale = 'ru' if action == 'generate_story_ru' else 'en'
            source = media_for(draft, locale)
            generated = generate_story_safe_media(source, draft['id'], locale)
            field = 'media_ru_json' if locale == 'ru' else 'media_en_json'
            update_draft(draft['id'], **{field: json.dumps(generated, ensure_ascii=False)})
            if draft.get('status') == 'scheduled':
                rebalance_all_scheduled_drafts()
            answer_callback(callback['id'], f'{locale.upper()} 9:16 generated')
            send_preview(chat_id, draft['id'])
        elif action == 'use_ru_media':
            update_draft(int(parts[1]), media_en_json=None)
            if (get_draft(int(parts[1])) or {}).get('status') == 'scheduled':
                rebalance_all_scheduled_drafts()
            answer_callback(callback['id'], 'EN media reset to RU fallback')
            send_preview(chat_id, int(parts[1]))
        elif action == 'cancel':
            cancel_scheduled_draft(int(parts[1]))
            set_state(user_id)
            answer_callback(callback['id'], 'Cancelled')
            api('sendMessage', {'chat_id': chat_id, 'text': f'Draft #{parts[1]} cancelled.'})
        elif action in {'approve', 'approve_now', 'schedule'}:
            draft = get_draft(int(parts[1]))
            targets = targets_for(draft)
            has_en_targets = any(
                enabled and TARGET_BY_ID.get(target_id) and TARGET_BY_ID[target_id].locale == 'en'
                for target_id, enabled in targets.items()
            )
            if has_en_targets and not (draft.get('text_en_approved') or draft.get('text_en_machine') or draft.get('media_en_json') or draft.get('media_ru_json')):
                answer_callback(callback['id'], 'EN text required')
                return
            if action == 'schedule':
                api(
                    'sendMessage',
                    {
                        'chat_id': chat_id,
                        'text': f'Choose schedule time for draft #{draft["id"]}. Manual format: HH:MM or DD.MM HH:MM.',
                        'reply_markup': schedule_choice_keyboard(draft['id']),
                    },
                )
                answer_callback(callback['id'])
                return
            post_id = publish_to_channel(draft, publish_now=True)
            rebalance_all_scheduled_drafts()
            answer_callback(callback['id'], 'Published')
            api('sendMessage', {'chat_id': chat_id, 'text': publish_report(post_id), 'disable_web_page_preview': True})
        elif action == 'sched_auto':
            result = schedule_draft(int(parts[1]))
            answer_callback(callback['id'], 'Scheduled')
            api('sendMessage', {'chat_id': chat_id, 'text': f'Draft #{parts[1]} scheduled.\n{schedule_summary(result)}'})
            send_preview(chat_id, int(parts[1]))
        elif action == 'sched_preset':
            scope, kind, draft_id = parts[1], parts[2], int(parts[3])
            value = preset_schedule_time(kind)
            result = schedule_draft_at(
                draft_id,
                scheduled_at=value if scope in {'both', 'ru'} else None,
                scheduled_en_at=value if scope in {'both', 'en'} else None,
            )
            answer_callback(callback['id'], 'Scheduled')
            api('sendMessage', {'chat_id': chat_id, 'text': f'Draft #{draft_id} scheduled.\n{schedule_summary(result)}'})
            send_preview(chat_id, draft_id)
        elif action == 'sched_manual':
            scope, draft_id = parts[1], int(parts[2])
            set_state(user_id, f'schedule_manual_{scope}', draft_id)
            answer_callback(callback['id'], 'Send time')
            api('sendMessage', {'chat_id': chat_id, 'text': 'Send time as HH:MM or DD.MM HH:MM.'})
    except Exception as exc:
        log(f'callback failed: {exc}')
        answer_callback(callback['id'], 'Failed')
        api('sendMessage', {'chat_id': chat_id, 'text': f'Error: {exc}'})
