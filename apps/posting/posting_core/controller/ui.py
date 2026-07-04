from __future__ import annotations

import json

from posting_core.controller.config import api
from posting_core.controller.db import get_draft, update_draft
from posting_core.controller.media import media_format_key, media_summary, story_media_status
from posting_core.controller.routing import route_targets_for_media
from posting_core.targets import CAPABILITY_RULES, DEFAULT_TARGETS, PRESETS, TARGET_LABELS, TOGGLE_TARGETS
from posting_core.scheduling import format_msk


def targets_for(draft):
    targets = DEFAULT_TARGETS.copy()
    try:
        targets.update(json.loads(draft.get('targets_json') or '{}'))
    except Exception:
        pass
    return targets


def media_for(draft, locale):
    raw = draft.get('media_en_json') if locale == 'en' else draft.get('media_ru_json')
    if not raw and locale == 'en':
        raw = draft.get('media_ru_json')
    return json.loads(raw) if raw else None

def keyboard(draft):
    targets = targets_for(draft)
    rows = [
        [
            {'text': 'Full', 'callback_data': f'preset:full:{draft["id"]}'},
            {'text': 'RU only', 'callback_data': f'preset:ru:{draft["id"]}'},
            {'text': 'EN only', 'callback_data': f'preset:en:{draft["id"]}'},
            {'text': 'TG only', 'callback_data': f'preset:tg:{draft["id"]}'},
        ],
    ]
    for i in range(0, len(TOGGLE_TARGETS), 2):
        row = []
        for target in TOGGLE_TARGETS[i:i+2]:
            mark = '✅' if targets.get(target) else '⬜'
            row.append({'text': f'{mark} {TARGET_LABELS[target]}', 'callback_data': f'toggle:{target}:{draft["id"]}'})
        rows.append(row)
    rows.extend([
        [
            {'text': 'Edit RU', 'callback_data': f'edit_ru:{draft["id"]}'},
            {'text': 'Edit EN', 'callback_data': f'edit_en:{draft["id"]}'},
            {'text': 'Regenerate EN', 'callback_data': f'regen_en:{draft["id"]}'},
        ],
        [{'text': 'Replace RU media', 'callback_data': f'replace_ru_media:{draft["id"]}'}, {'text': 'Replace EN media', 'callback_data': f'replace_en_media:{draft["id"]}'}],
        [{'text': 'Generate RU 9:16', 'callback_data': f'generate_story_ru:{draft["id"]}'}, {'text': 'Generate EN 9:16', 'callback_data': f'generate_story_en:{draft["id"]}'}],
        [{'text': 'Use RU media for EN', 'callback_data': f'use_ru_media:{draft["id"]}'}],
        [
            {'text': 'Publish now', 'callback_data': f'approve_now:{draft["id"]}'},
            {'text': 'Schedule', 'callback_data': f'schedule:{draft["id"]}'},
        ],
        [{'text': 'Cancel', 'callback_data': f'cancel:{draft["id"]}'}],
    ])
    return {'inline_keyboard': rows}


def schedule_keyboard(drafts):
    rows = [
        [
            {
                'text': (
                    f'#{draft["post_id"] or "?"} · '
                    f'{format_msk(draft["scheduled_at"] or draft["scheduled_en_at"])}'
                ),
                'callback_data': f'schedule_open:{draft["id"]}',
            }
        ]
        for draft in drafts
    ]
    return {'inline_keyboard': rows}


def schedule_choice_keyboard(draft_id):
    return {
        'inline_keyboard': [
            [
                {'text': 'Auto next slots', 'callback_data': f'sched_auto:{draft_id}'},
                {'text': '+30 min', 'callback_data': f'sched_preset:both:plus30:{draft_id}'},
            ],
            [
                {'text': '+1 hour', 'callback_data': f'sched_preset:both:plus60:{draft_id}'},
                {'text': 'Today 21:00', 'callback_data': f'sched_preset:both:today2100:{draft_id}'},
            ],
            [
                {'text': 'Tomorrow 10:00', 'callback_data': f'sched_preset:both:tomorrow1000:{draft_id}'},
                {'text': 'Manual time', 'callback_data': f'sched_manual:both:{draft_id}'},
            ],
            [
                {'text': 'Schedule RU', 'callback_data': f'sched_manual:ru:{draft_id}'},
                {'text': 'Schedule EN', 'callback_data': f'sched_manual:en:{draft_id}'},
            ],
            [{'text': 'Back', 'callback_data': f'schedule_open:{draft_id}'}],
        ]
    }


def preview_text(draft):
    targets = targets_for(draft)
    media_ru = media_for(draft, 'ru')
    routed_targets, format_key, notes = route_targets_for_media(targets, media_ru)
    if routed_targets != targets:
        update_draft(draft['id'], targets_json=json.dumps(routed_targets, ensure_ascii=False))
        targets = routed_targets
    enabled = ', '.join(TARGET_LABELS[t] for t in TOGGLE_TARGETS if targets.get(t)) or 'none'
    media_en = json.loads(draft.get('media_en_json')) if draft.get('media_en_json') else None
    media_en_effective = media_en or media_ru
    en_media_note = 'custom EN media' if media_en else ('RU media fallback' if media_ru else 'none')
    ru_text = draft["text_ru"] or "[media only]"
    en_text = draft.get("text_en_approved") or draft.get("text_en_machine") or ("[media only]" if not draft["text_ru"] else "")
    routing_note = ("\nRouting: " + "; ".join(notes)) if notes else ""
    preflight_notes = []
    if targets.get("telegram_stories") or targets.get("instagram_stories_ru"):
        preflight_notes.extend(f"RU/TG story: {note}" for note in story_media_status(media_ru).splitlines())
    if targets.get("instagram_stories"):
        preflight_notes.extend(f"EN story: {note}" for note in story_media_status(media_en_effective).splitlines())
    preflight_note = ""
    if preflight_notes:
        preflight_note = "\nPreflight:\n" + "\n".join(f'- {note}' for note in preflight_notes)
    schedule_note = ""
    if draft.get("status") == "scheduled" and draft.get("scheduled_at"):
        schedule_note = (
            f'\nScheduled RU: {format_msk(draft["scheduled_at"])}'
            f'\nScheduled EN: {format_msk(draft["scheduled_en_at"])}'
        )
    return (
        f'Draft #{draft["id"]}\n\n'
        f'RU:\n{ru_text}\n\n'
        f'EN:\n{en_text}\n\n'
        f'Targets: {enabled}\n'
        f'RU media: {media_summary(media_ru)}\n'
        f'EN media: {en_media_note}\n'
        f'Format: {format_key}{routing_note}{preflight_note}{schedule_note}'
    )


def send_preview(chat_id, draft_id):
    draft = get_draft(draft_id)
    text = preview_text(draft)
    draft = get_draft(draft_id)
    api('sendMessage', {'chat_id': chat_id, 'text': text, 'reply_markup': keyboard(draft), 'disable_web_page_preview': True})


def answer_callback(callback_id, text='ok'):
    api('answerCallbackQuery', {'callback_query_id': callback_id, 'text': text})


def apply_preset(draft_id, preset):
    draft = get_draft(draft_id)
    targets = DEFAULT_TARGETS.copy()
    for t in TOGGLE_TARGETS:
        targets[t] = False
    targets.update(PRESETS[preset])
    targets, _, _ = route_targets_for_media(targets, media_for(draft, 'ru'))
    update_draft(draft_id, targets_json=json.dumps(targets, ensure_ascii=False))


def toggle_target(draft_id, target):
    draft = get_draft(draft_id)
    targets = targets_for(draft)
    if not targets.get(target):
        format_key = media_format_key(media_for(draft, 'ru'))
        status = CAPABILITY_RULES.get(format_key, {}).get(target, 'unknown')
        if status in {'unsupported', 'unknown'}:
            raise RuntimeError(f'{TARGET_LABELS[target]} does not support {format_key}')
    targets[target] = not targets.get(target)
    update_draft(draft_id, targets_json=json.dumps(targets, ensure_ascii=False))
