from __future__ import annotations

import json
import urllib.request
from posting_core.controller.config import DEEPSEEK_API_KEY, log

def has_cyrillic(value):
    return any('\u0400' <= ch <= '\u04FF' for ch in (value or ''))


def one_word_translation_fallback(value):
    normalized = (value or '').strip().lower()
    mapping = {
        'проверка': 'Check',
        'тест': 'Test',
    }
    return mapping.get(normalized, '')


def translate_ru_to_en(text):
    if not DEEPSEEK_API_KEY or not text:
        return ''
    system = (
        "You are a senior English tech-news editor preparing Telegram posts for English-speaking developers.\n"
        "Convert the user message into clean natural English. The input is usually Russian, but it may be English, mixed language, a short test phrase, or a single word.\n"
        "Never ask the user for another message. Never explain that the input is missing or not Russian. Never add helper text.\n"
        "If the input is already English, return the same meaning in polished English. If it is a one-word test like Test, return Test.\n"
        "Do not translate literally when Russian tech/product slang has a standard English meaning.\n"
        "Glossary:\n"
        "- сбросил лимиты -> reset the limits / reset usage limits\n"
        "- сброс лимитов -> limit reset\n"
        "- слив -> leak\n"
        "- релиз -> release\n"
        "- подарил -> added or granted depending on context\n"
        "- связка из [X] -> [X] pattern / combination\n"
        "- вести диалог -> handle/manage the conversation\n"
        "- работать с кодом -> work on code (not 'work with code')\n"
        "- всё сильнее видна -> is starting to emerge / is becoming clear\n"
        "Preserve product names, commands, URLs, and emojis.\n"
        "Formatting and style rules:\n"
        "1. Casing: If a list item in the source text starts with a lowercase letter, its translation MUST also start with a lowercase letter (e.g. '• новая система...' -> '• the new system...'). Do not automatically capitalize the first word of list items unless the original Russian word is capitalized or a proper noun.\n"
        "2. Bullet points: If the list items in the input start with bullet points (•), you MUST preserve the exact bullet point character (•) in the English translation.\n"
        "3. Punctuation & Connectors: Do not use em-dashes (—) or hyphens surrounded by spaces as connectors (e.g. 'ИИ может... — разговор становится...'). Translate them into comma-connected gerund clauses (e.g. ', making conversations feel...') or split into separate clauses to sound more natural.\n"
        "4. Pronouns: Avoid repeating 'the AI' or 'AI' if the subject (e.g., ChatGPT, the system) is already clear in context. Use 'it' or 'the system' instead (e.g., '• ИИ может...' -> '• it can...').\n"
        "5. Redundancy: Avoid redundant translations of 'параллельно' (in parallel/concurrently) when the concurrency is already expressed by connectors like 'while' or 'as' (e.g. 'а фоновый агент параллельно работает...' -> ', while a background agent works...').\n"
        "6. Tone: Write in a modern, concise, tech-native style (like posts on Hacker News or tweets by tech developers). Avoid formal, academic, or overly literal translations. Prefer simple active verbs and clean phrasing.\n"
        "Output only the English post text."
    )
    def call_deepseek(system_prompt):
        payload = {'model': 'deepseek-chat', 'messages': [{'role': 'system', 'content': system_prompt}, {'role': 'user', 'content': text}], 'temperature': 0.1}
        req = urllib.request.Request('https://api.deepseek.com/v1/chat/completions', data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {DEEPSEEK_API_KEY}'}, method='POST')
        with urllib.request.urlopen(req, timeout=40) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        return data['choices'][0]['message']['content'].strip()

    try:
        translated = call_deepseek(system)
        bad_markers = (
            "i don't see any russian",
            "please provide the text",
            "provide the text you'd like",
            "could you please provide",
            "i'd be happy to help",
        )
        bad_reply = any(marker in translated.lower() for marker in bad_markers)
        if has_cyrillic(text) and (bad_reply or has_cyrillic(translated)):
            strict_system = (
                'Translate the user text from Russian to English. Return only English text. '
                'This may be a single lowercase word or a short test phrase. Do not copy Cyrillic text. '
                'Examples: проверка -> Check; тест -> Test; проверка связи -> Connection check.'
            )
            try:
                retry = call_deepseek(strict_system)
                if retry and not has_cyrillic(retry) and not any(marker in retry.lower() for marker in bad_markers):
                    return retry
            except Exception as retry_exc:
                log(f'translation retry failed: {retry_exc}')
            fallback = one_word_translation_fallback(text)
            if fallback:
                return fallback
            log('translation still contains Cyrillic after retry; returning empty EN text')
            return ''
        if bad_reply:
            log('translation returned helper text; falling back to source text')
            return text.strip()
        return translated
    except Exception as exc:
        log(f'translation failed: {exc}')
        fallback = one_word_translation_fallback(text)
        return fallback
