from __future__ import annotations

from posting_core.controller.media import media_format_key
from posting_core.targets import CAPABILITY_RULES, TARGET_LABELS, TOGGLE_TARGETS

def route_targets_for_media(targets, media):
    format_key = media_format_key(media)
    rules = CAPABILITY_RULES.get(format_key, {})
    routed = targets.copy()
    notes = []
    for target in TOGGLE_TARGETS:
        status = rules.get(target, 'unknown')
        if routed.get(target) and status in {'unsupported', 'unknown'}:
            routed[target] = False
            notes.append(f'{TARGET_LABELS[target]} disabled: {format_key} is {status}')
        elif routed.get(target) and status == 'partial':
            notes.append(f'{TARGET_LABELS[target]} partial: {format_key} will use platform fallback')
    return routed, format_key, notes
