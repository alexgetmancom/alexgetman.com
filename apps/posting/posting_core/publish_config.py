from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

FEED_JSON = Path(os.environ.get("FEED_JSON", "/feed-data/feed.json"))
SSH_KEY_PATH = "/root/.ssh/id_ed25519"

# Environment
THREADS_ACCESS_TOKEN = os.environ.get("THREADS_ACCESS_TOKEN")
THREADS_EN_ACCESS_TOKEN = os.environ.get("THREADS_EN_ACCESS_TOKEN")
CONTROLLER_BOT_TOKEN = os.environ.get("CONTROLLER_BOT_TOKEN")
TELEGRAM_BOT_TOKEN = CONTROLLER_BOT_TOKEN or os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_STORIES_BOT_TOKEN = os.environ.get("TELEGRAM_STORIES_BOT_TOKEN") or CONTROLLER_BOT_TOKEN or TELEGRAM_BOT_TOKEN
TELEGRAM_STORIES_BUSINESS_CONNECTION_ID = os.environ.get("TELEGRAM_STORIES_BUSINESS_CONNECTION_ID")
TELEGRAM_CHANNEL_STORIES_API_ID = os.environ.get("TELEGRAM_CHANNEL_STORIES_API_ID") or os.environ.get("TELEGRAM_API_ID")
TELEGRAM_CHANNEL_STORIES_API_HASH = os.environ.get("TELEGRAM_CHANNEL_STORIES_API_HASH") or os.environ.get("TELEGRAM_API_HASH")
TELEGRAM_CHANNEL_STORIES_SESSION = os.environ.get("TELEGRAM_CHANNEL_STORIES_SESSION", "/data/telegram_channel_stories")
TELEGRAM_API_BASE_URL = os.environ.get("TELEGRAM_API_BASE_URL", "https://api.telegram.org").rstrip("/")
TELEGRAM_ALLOWED_CHATS = os.environ.get("TELEGRAM_ALLOWED_CHATS")
TELEGRAM_OFFSET_POLL_ENABLED = os.environ.get("TELEGRAM_OFFSET_POLL_ENABLED", "false").lower() == "true"
PUBLIC_MEDIA_BASE_URL = os.environ.get("PUBLIC_MEDIA_BASE_URL", "https://alexgetman.com/media/threads")
REMOTE_MEDIA_PATH = os.environ.get("REMOTE_MEDIA_PATH", "deploy@5.129.238.194:/home/deploy/ialexey-web/media/threads/")
THREADS_CONTAINER_TIMEOUT_SECONDS = int(os.environ.get("THREADS_CONTAINER_TIMEOUT_SECONDS", "900"))
MEDIA_GROUP_SETTLE_SECONDS = float(os.environ.get("MEDIA_GROUP_SETTLE_SECONDS", "5"))
IDLE_POLL_INTERVAL_SECONDS = int(os.environ.get("IDLE_POLL_INTERVAL_SECONDS", "300"))
PENDING_MEDIA_GROUP_POLL_INTERVAL_SECONDS = int(os.environ.get("PENDING_MEDIA_GROUP_POLL_INTERVAL_SECONDS", "1"))
EN_TRANSLATION_WAIT_SECONDS = int(os.environ.get("EN_TRANSLATION_WAIT_SECONDS", "90"))
EN_TRANSLATION_POLL_SECONDS = float(os.environ.get("EN_TRANSLATION_POLL_SECONDS", "3"))
TEMP_MEDIA_DIR = Path(os.environ.get("TEMP_MEDIA_DIR", "/tmp/alexgetman-posting"))
TEMP_MEDIA_MAX_AGE_SECONDS = int(os.environ.get("TEMP_MEDIA_MAX_AGE_SECONDS", "86400"))
KEEP_STAGED_MEDIA_FOR_FACEBOOK = os.environ.get("KEEP_STAGED_MEDIA_FOR_FACEBOOK", "true").lower() == "true"
STAGED_MEDIA_MAX_AGE_SECONDS = int(os.environ.get("STAGED_MEDIA_MAX_AGE_SECONDS", "172800"))
MEDIA_CLEANUP_INTERVAL_SECONDS = int(os.environ.get("MEDIA_CLEANUP_INTERVAL_SECONDS", "3600"))
PUBLISH_MAX_WORKERS = int(os.environ.get("PUBLISH_MAX_WORKERS", "4"))
PUBLISH_JOB_CLAIM_LIMIT = int(os.environ.get("PUBLISH_JOB_CLAIM_LIMIT", "20"))

FACEBOOK_PAGE_ID = os.environ.get("FACEBOOK_PAGE_ID")
FACEBOOK_PAGE_ACCESS_TOKEN = os.environ.get("FACEBOOK_PAGE_ACCESS_TOKEN")
FACEBOOK_RU_PAGE_ID = os.environ.get("FACEBOOK_RU_PAGE_ID")
FACEBOOK_RU_PAGE_ACCESS_TOKEN = os.environ.get("FACEBOOK_RU_PAGE_ACCESS_TOKEN")
FACEBOOK_GRAPH_API_VERSION = os.environ.get("FACEBOOK_GRAPH_API_VERSION", "v25.0").strip() or "v25.0"
if not FACEBOOK_GRAPH_API_VERSION.startswith("v"):
    FACEBOOK_GRAPH_API_VERSION = "v" + FACEBOOK_GRAPH_API_VERSION

INSTAGRAM_USER_ID = os.environ.get("INSTAGRAM_USER_ID")
INSTAGRAM_ACCESS_TOKEN = os.environ.get("INSTAGRAM_ACCESS_TOKEN")
INSTAGRAM_RU_USER_ID = os.environ.get("INSTAGRAM_RU_USER_ID") or INSTAGRAM_USER_ID
INSTAGRAM_RU_ACCESS_TOKEN = os.environ.get("INSTAGRAM_RU_ACCESS_TOKEN") or INSTAGRAM_ACCESS_TOKEN
INSTAGRAM_EN_USER_ID = os.environ.get("INSTAGRAM_EN_USER_ID")
INSTAGRAM_EN_ACCESS_TOKEN = os.environ.get("INSTAGRAM_EN_ACCESS_TOKEN")
INSTAGRAM_GRAPH_API_VERSION = os.environ.get("INSTAGRAM_GRAPH_API_VERSION", "v21.0").strip() or "v21.0"
if not INSTAGRAM_GRAPH_API_VERSION.startswith("v"):
    INSTAGRAM_GRAPH_API_VERSION = "v" + INSTAGRAM_GRAPH_API_VERSION

LINKEDIN_AUTHOR_URN = os.environ.get("LINKEDIN_AUTHOR_URN")
LINKEDIN_ACCESS_TOKEN = os.environ.get("LINKEDIN_ACCESS_TOKEN")

X_CONSUMER_KEY = os.environ.get("X_CONSUMER_KEY")
X_CONSUMER_SECRET = os.environ.get("X_CONSUMER_SECRET")
X_ACCESS_TOKEN = os.environ.get("X_ACCESS_TOKEN")
X_ACCESS_TOKEN_SECRET = os.environ.get("X_ACCESS_TOKEN_SECRET")

# Bluesky (AT Protocol)
BLUESKY_HANDLE = os.environ.get("BLUESKY_HANDLE")  # e.g. alexgetmancom.bsky.social
BLUESKY_APP_PASSWORD = os.environ.get("BLUESKY_APP_PASSWORD")

# Mastodon
MASTODON_INSTANCE = os.environ.get("MASTODON_INSTANCE", "mastodon.social")
MASTODON_ACCESS_TOKEN = os.environ.get("MASTODON_ACCESS_TOKEN")

# dev.to
DEVTO_API_KEY = os.environ.get("DEVTO_API_KEY")
PUBLIC_SITE_BASE_URL = os.environ.get("PUBLIC_SITE_BASE_URL", "https://alexgetman.com")

# GitHub Discussions (for Giscus comments & posts)
GITHUB_DISCUSSIONS_TOKEN = os.environ.get("GITHUB_DISCUSSIONS_TOKEN")
GITHUB_DISCUSSIONS_REPO_ID = os.environ.get("GITHUB_DISCUSSIONS_REPO_ID", "R_kgDOSJwPnQ")
GITHUB_DISCUSSIONS_CATEGORY_ID = os.environ.get("GITHUB_DISCUSSIONS_CATEGORY_ID", "DIC_kwDOSJwPnc4C-S2f")

ENABLE_THREADS = os.environ.get("ENABLE_THREADS", "true").lower() == "true"
ENABLE_FACEBOOK = os.environ.get("ENABLE_FACEBOOK", "false").lower() == "true"
ENABLE_FACEBOOK_RU = os.environ.get("ENABLE_FACEBOOK_RU", "false").lower() == "true"
ENABLE_LINKEDIN = os.environ.get("ENABLE_LINKEDIN", "false").lower() == "true"
ENABLE_X = os.environ.get("ENABLE_X", "false").lower() == "true"
ENABLE_BLUESKY = os.environ.get("ENABLE_BLUESKY", "false").lower() == "true"
ENABLE_MASTODON = os.environ.get("ENABLE_MASTODON", "false").lower() == "true"
ENABLE_DEVTO = os.environ.get("ENABLE_DEVTO", "false").lower() == "true"
ENABLE_GITHUB_EN = os.environ.get("ENABLE_GITHUB_EN", "false").lower() == "true"
ENABLE_GITHUB_RU = os.environ.get("ENABLE_GITHUB_RU", "false").lower() == "true"
ENABLE_TELEGRAM_STORIES = os.environ.get("ENABLE_TELEGRAM_STORIES", "false").lower() == "true"
ENABLE_INSTAGRAM_STORIES = os.environ.get("ENABLE_INSTAGRAM_STORIES", "false").lower() == "true"


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)
