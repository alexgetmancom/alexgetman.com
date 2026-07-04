from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

TargetKind = Literal["telegram", "site", "social"]
Locale = Optional[Literal["ru", "en"]]


@dataclass(frozen=True)
class PlatformTarget:
    id: str
    label: str
    kind: TargetKind
    locale: Locale
    default_enabled: bool
    supports_publish: bool
    supports_edit: bool
    supports_metrics: bool
    credential_env: tuple[str, ...] = ()


TARGETS: tuple[PlatformTarget, ...] = (
    PlatformTarget("telegram", "Telegram", "telegram", "ru", True, False, True, True, ("CONTROLLER_BOT_TOKEN",)),
    PlatformTarget("site_ru", "Site RU", "site", "ru", True, False, True, True),
    PlatformTarget("site_en", "Site EN", "site", "en", True, False, True, True),
    PlatformTarget("threads_ru", "Threads RU", "social", "ru", True, True, False, True, ("THREADS_ACCESS_TOKEN",)),
    PlatformTarget("facebook_ru", "Facebook RU", "social", "ru", True, True, True, True, ("FACEBOOK_RU_PAGE_ID", "FACEBOOK_RU_PAGE_ACCESS_TOKEN")),
    PlatformTarget("linkedin", "LinkedIn", "social", "en", True, True, True, True, ("LINKEDIN_AUTHOR_URN", "LINKEDIN_ACCESS_TOKEN")),
    PlatformTarget("facebook", "Facebook EN", "social", "en", True, True, True, True, ("FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN")),
    PlatformTarget("threads_en", "Threads EN", "social", "en", True, True, False, True, ("THREADS_EN_ACCESS_TOKEN",)),
    PlatformTarget("x", "X (Twitter)", "social", "en", True, True, False, True, ("X_ACCESS_TOKEN",)),
    PlatformTarget("bluesky", "Bluesky", "social", "en", True, True, False, True, ("BLUESKY_APP_PASSWORD",)),
    PlatformTarget("mastodon", "Mastodon", "social", "en", True, True, False, True, ("MASTODON_ACCESS_TOKEN",)),
    PlatformTarget("devto", "dev.to", "social", "en", True, True, False, True, ("DEVTO_API_KEY",)),
    PlatformTarget("github_en", "GitHub EN", "social", "en", True, True, False, True, ("GITHUB_DISCUSSIONS_TOKEN",)),
    PlatformTarget("github_ru", "GitHub RU", "social", "ru", True, True, False, True, ("GITHUB_DISCUSSIONS_TOKEN",)),
    PlatformTarget("telegram_stories", "Telegram Stories", "social", "ru", True, True, False, True, ("TELEGRAM_CHANNEL_STORIES_API_ID", "TELEGRAM_CHANNEL_STORIES_API_HASH")),
    PlatformTarget("instagram_stories_ru", "Instagram Stories RU", "social", "ru", True, True, False, True, ("INSTAGRAM_RU_USER_ID", "INSTAGRAM_RU_ACCESS_TOKEN")),
    PlatformTarget("instagram_stories", "Instagram Stories EN", "social", "en", True, True, False, True, ("INSTAGRAM_EN_USER_ID", "INSTAGRAM_EN_ACCESS_TOKEN")),
)

TARGET_BY_ID = {target.id: target for target in TARGETS}
ALL_TARGET_IDS = tuple(target.id for target in TARGETS)
PUBLISH_TARGET_IDS = ALL_TARGET_IDS
SOCIAL_TARGET_IDS = tuple(target.id for target in TARGETS if target.kind == "social" and target.supports_publish)
METRIC_TARGET_IDS = tuple(target.id for target in TARGETS if target.supports_metrics)
EDITABLE_TARGET_IDS = tuple(target.id for target in TARGETS if target.supports_edit)
DEFAULT_TARGETS = {target.id: target.default_enabled for target in TARGETS}
TARGET_LABELS = {target.id: target.label for target in TARGETS}
TOGGLE_TARGETS = ALL_TARGET_IDS
CREDENTIAL_REQUIREMENTS = {
    **{target.id: target.credential_env for target in TARGETS if target.credential_env},
    "controller_bot": ("CONTROLLER_BOT_TOKEN", "CONTROLLER_ADMIN_IDS"),
    "translation": ("DEEPSEEK_API_KEY",),
}

PRESETS = {
    "full": DEFAULT_TARGETS.copy(),
    "ru": {
        target.id: target.default_enabled and target.locale == "ru"
        for target in TARGETS
    },
    "en": {
        target.id: target.default_enabled and target.locale == "en"
        for target in TARGETS
    },
    "tg": {target.id: target.id == "telegram" for target in TARGETS},
}

CAPABILITY_RULES = {
    "text_only": {target.id: "supported" for target in TARGETS},
    "single_image": {target.id: "supported" for target in TARGETS},
    "image_album": {target.id: "supported" for target in TARGETS},
    "single_video": {target.id: "supported" for target in TARGETS},
    "video_album": {
        target.id: "partial" if target.id in {"threads_ru", "threads_en", "linkedin"} else "supported"
        for target in TARGETS
    },
    "mixed_media": {
        target.id: "partial" if target.id in {"threads_ru", "threads_en", "linkedin"} else "supported"
        for target in TARGETS
    },
}

for story_target in ("telegram_stories", "instagram_stories_ru", "instagram_stories"):
    CAPABILITY_RULES["text_only"][story_target] = "unsupported"
    CAPABILITY_RULES["image_album"][story_target] = "partial"
    CAPABILITY_RULES["video_album"][story_target] = "partial"
    CAPABILITY_RULES["mixed_media"][story_target] = "partial"
