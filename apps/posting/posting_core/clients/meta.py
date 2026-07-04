from __future__ import annotations

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from posting_core.http_client import request
from posting_core.state import publish_plan_for_message, publish_plan_for_post, plan_target_enabled, wait_for_english_translation
from posting_core.media import delete_media_from_vps, normalize_video_for_threads, plan_media_to_items, prepare_crosspost_media_items, upload_media_to_vps
from posting_core.clients.telegram import get_telegram_file_url
from posting_core.clients.facebook import publish_to_facebook
from posting_core.clients.linkedin import publish_to_linkedin
from posting_core.clients.threads import publish_to_threads_target
from posting_core.clients.x import publish_to_x
from posting_core.clients.bluesky import bluesky_public_url, publish_to_bluesky, verify_bluesky_root_visible
from posting_core.clients.mastodon import publish_to_mastodon
from posting_core.clients.devto import publish_to_devto
from posting_core.clients.github import publish_to_github_discussion
from posting_core.clients.instagram import publish_instagram_story
from posting_core.clients.telegram_stories import publish_telegram_story
from posting_core.publish_config import (
    ENABLE_FACEBOOK,
    ENABLE_FACEBOOK_RU,
    ENABLE_LINKEDIN,
    ENABLE_THREADS,
    ENABLE_X,
    ENABLE_BLUESKY,
    ENABLE_MASTODON,
    ENABLE_DEVTO,
    ENABLE_GITHUB_EN,
    ENABLE_GITHUB_RU,
    ENABLE_INSTAGRAM_STORIES,
    BLUESKY_APP_PASSWORD,
    MASTODON_ACCESS_TOKEN,
    DEVTO_API_KEY,
    GITHUB_DISCUSSIONS_TOKEN,
    INSTAGRAM_EN_ACCESS_TOKEN,
    INSTAGRAM_EN_USER_ID,
    INSTAGRAM_RU_ACCESS_TOKEN,
    INSTAGRAM_RU_USER_ID,
    FACEBOOK_PAGE_ACCESS_TOKEN,
    FACEBOOK_PAGE_ID,
    FACEBOOK_RU_PAGE_ACCESS_TOKEN,
    FACEBOOK_RU_PAGE_ID,
    KEEP_STAGED_MEDIA_FOR_FACEBOOK,
    LINKEDIN_ACCESS_TOKEN,
    LINKEDIN_AUTHOR_URN,
    PUBLIC_MEDIA_BASE_URL,
    PUBLISH_MAX_WORKERS,
    TEMP_MEDIA_DIR,
    THREADS_ACCESS_TOKEN,
    THREADS_EN_ACCESS_TOKEN,
    X_ACCESS_TOKEN,
    X_ACCESS_TOKEN_SECRET,
    X_CONSUMER_KEY,
    X_CONSUMER_SECRET,
    log,
)


def _safe_media_name(value):
    import re

    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value)).strip("_")[:120] or "media"


def _first_public_image_url(media_items):
    for item in media_items or []:
        if item.get("type") != "IMAGE":
            continue
        for key in ("vps_url", "public_url", "url"):
            value = item.get(key)
            if value and str(value).startswith(("http://", "https://")):
                return value
    return None


def _normalize_target_result(result):
    if isinstance(result, dict):
        return result
    if isinstance(result, str):
        return {"ok": True, "id": result, "url": result}
    if result is None:
        return {"ok": False, "error": "empty_publish_result"}
    return {"ok": bool(result), "id": str(result)}


def _skipped(reason: str | None = None):
    result = {"ok": False, "skipped": True}
    if reason:
        result["reason"] = reason
    return result


def _target_allowed(plan, target: str, *requirements) -> bool:
    return all(requirements) and plan_target_enabled(plan, target, True)


def _publish_guarded(target: str, action):
    log(f"Async target start: {target}")
    try:
        return action()
    except Exception as exc:
        log(f"Error crossposting to {target}: {exc}")
        return {"ok": False, "error": str(exc)}


def crosspost_to_targets(text, media_items, message_id=None, post_id=None, allowed_targets=None):
    """
    media_items is a list of dicts: [{"type": "IMAGE"|"VIDEO", "file_id": "..."}]
    """
    published_ids = []
    allowed_targets = set(allowed_targets or ["threads_ru", "threads_en", "facebook", "facebook_ru", "linkedin", "x"])
    target_status = {
        "threads_ru": {"ok": False, "ids": []},
        "threads_en": {"ok": False, "ids": []},
        "facebook": {"ok": False, "id": None},
        "facebook_ru": {"ok": False, "id": None},
        "linkedin": {"ok": False, "id": None},
        "x": {"ok": False, "id": None},
        "bluesky": {"ok": False, "id": None},
        "mastodon": {"ok": False, "id": None},
        "devto": {"ok": False, "id": None},
        "github_en": {"ok": False, "id": None},
        "github_ru": {"ok": False, "id": None},
        "telegram_stories": {"ok": False, "id": None},
        "instagram_stories_ru": {"ok": False, "id": None},
        "instagram_stories": {"ok": False, "id": None},
    }
    
    plan = publish_plan_for_post(post_id) if post_id else publish_plan_for_message(message_id)
    uploaded_files = []
    local_files_to_cleanup = []

    try:
        # Step 1: Prepare shared RU media once for all targets.
        for i, item in enumerate(media_items):
            item_type = item["type"]
            ext = ".mp4" if item_type == "VIDEO" else ".jpg"
            local_source = item.get("local_path") or item.get("path")
            file_id = item.get("file_id")
            source_name = _safe_media_name(file_id or local_source or f"{post_id or message_id}_{i}")
            if local_source:
                local_path = Path(local_source)
                log(f"Using local {item_type.lower()} file: {local_path}")
            else:
                telegram_file = get_telegram_file_url(file_id, token=item.get("token"))
                if not telegram_file:
                    log(f"Failed to get file URL from Telegram for file_id: {file_id}")
                    continue

                temp_download = not os.path.isabs(telegram_file)
                if temp_download:
                    TEMP_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
                    local_path = TEMP_MEDIA_DIR / f"{source_name}{ext}"
                    log(f"Downloading {item_type.lower()} from Telegram...")
                    local_path.write_bytes(request(telegram_file, timeout=60).body)
                    local_files_to_cleanup.append(local_path)
                else:
                    local_path = Path(telegram_file)
                    log(f"Using local Telegram {item_type.lower()} file: {local_path}")

            upload_path = local_path
            normalized_path = None
            if item_type == "VIDEO":
                normalized_path = normalize_video_for_threads(local_path)
                upload_path = normalized_path
                local_files_to_cleanup.append(normalized_path)

            remote_filename = f"{int(time.time())}_{i}_{source_name}{ext}"
            upload_media_to_vps(upload_path, remote_filename)
            uploaded_files.append(remote_filename)

            item["vps_url"] = f"{PUBLIC_MEDIA_BASE_URL}/{remote_filename}"
            item["local_path"] = upload_path
    except Exception as exc:
        log(f"Error preparing media: {exc}")
        media_error = str(exc)
        target_status["threads_ru"] = {"ok": False, "error": media_error}
        target_status["threads_en"] = {"ok": False, "error": media_error}
        target_status["facebook"] = {"ok": False, "error": media_error}
        target_status["facebook_ru"] = {"ok": False, "error": media_error}
        target_status["linkedin"] = {"ok": False, "error": media_error}
        target_status["x"] = {"ok": False, "error": media_error}
    else:
        english_crosspost_enabled = (
            (ENABLE_FACEBOOK and FACEBOOK_PAGE_ACCESS_TOKEN and FACEBOOK_PAGE_ID and plan_target_enabled(plan, "facebook", True))
            or (ENABLE_LINKEDIN and LINKEDIN_ACCESS_TOKEN and LINKEDIN_AUTHOR_URN and plan_target_enabled(plan, "linkedin", True))
            or (ENABLE_THREADS and THREADS_EN_ACCESS_TOKEN and plan_target_enabled(plan, "threads_en", True))
            or (ENABLE_X and X_CONSUMER_KEY and X_CONSUMER_SECRET and X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET and plan_target_enabled(plan, "x", True))
            or (ENABLE_BLUESKY and BLUESKY_APP_PASSWORD and plan_target_enabled(plan, "bluesky", True))
            or (ENABLE_MASTODON and MASTODON_ACCESS_TOKEN and plan_target_enabled(plan, "mastodon", True))
            or (ENABLE_DEVTO and DEVTO_API_KEY and plan_target_enabled(plan, "devto", True))
            or (ENABLE_GITHUB_EN and GITHUB_DISCUSSIONS_TOKEN and plan_target_enabled(plan, "github_en", True))
            or (ENABLE_INSTAGRAM_STORIES and INSTAGRAM_EN_ACCESS_TOKEN and INSTAGRAM_EN_USER_ID and plan_target_enabled(plan, "instagram_stories", True))
        )
        english_media_lock = threading.Lock()
        english_media_cache = {"ready": False, "items": media_items}


        def publish_threads_task():
            return publish_to_threads_target(text, media_items, plan, THREADS_ACCESS_TOKEN, "threads_ru")

        def get_english_context(english_future):
            english_text = english_future.result() if english_future else None
            if not english_text:
                return None, media_items
            with english_media_lock:
                if not english_media_cache["ready"]:
                    custom_en_media = plan_media_to_items(plan)
                    if custom_en_media:
                        try:
                            prepared_en_media = prepare_crosspost_media_items(
                                custom_en_media,
                                uploaded_files,
                                local_files_to_cleanup,
                                "en",
                            )
                            if prepared_en_media:
                                english_media_cache["items"] = prepared_en_media
                                log("Using custom EN media for English crosspost targets.")
                        except Exception as exc:
                            log(f"Failed to prepare custom EN media, falling back to RU media: {exc}")
                    english_media_cache["ready"] = True
            return english_text, english_media_cache["items"]

        def publish_threads_en_task(english_future):
            if not (ENABLE_THREADS and THREADS_EN_ACCESS_TOKEN and plan_target_enabled(plan, "threads_en", True)):
                return {"ok": False, "skipped": True}
            log("Async target start: threads_en")
            english_text, english_media_items = get_english_context(english_future)
            if not english_text:
                return {"ok": False, "skipped": True, "reason": "missing_english_translation"}
            return publish_to_threads_target(english_text, english_media_items, plan, THREADS_EN_ACCESS_TOKEN, "threads_en")

        def publish_facebook_task(english_future):
            if not _target_allowed(plan, "facebook", ENABLE_FACEBOOK, FACEBOOK_PAGE_ACCESS_TOKEN, FACEBOOK_PAGE_ID):
                return _skipped()
            english_text, english_media_items = get_english_context(english_future)
            if not english_text:
                return _skipped("missing_english_translation")

            def action():
                facebook_id = publish_to_facebook(english_text, english_media_items)
                return {"ok": bool(facebook_id), "id": facebook_id}

            return _publish_guarded("facebook", action)

        def publish_linkedin_task(english_future):
            if not _target_allowed(plan, "linkedin", ENABLE_LINKEDIN, LINKEDIN_ACCESS_TOKEN, LINKEDIN_AUTHOR_URN):
                return _skipped()
            english_text, english_media_items = get_english_context(english_future)
            if not english_text:
                return _skipped("missing_english_translation")

            def action():
                linkedin_id = publish_to_linkedin(english_text, english_media_items)
                return {"ok": bool(linkedin_id), "id": linkedin_id}

            return _publish_guarded("linkedin", action)

        def publish_facebook_ru_task():
            if not _target_allowed(plan, "facebook_ru", ENABLE_FACEBOOK_RU, FACEBOOK_RU_PAGE_ACCESS_TOKEN, FACEBOOK_RU_PAGE_ID):
                return _skipped()

            def action():
                facebook_id = publish_to_facebook(text, media_items, page_id=FACEBOOK_RU_PAGE_ID, token=FACEBOOK_RU_PAGE_ACCESS_TOKEN)
                return {"ok": bool(facebook_id), "id": facebook_id}

            return _publish_guarded("facebook_ru", action)

        def publish_x_task(english_future):
            if not _target_allowed(plan, "x", ENABLE_X, X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET):
                return _skipped()
            english_text, english_media_items = get_english_context(english_future)
            if not english_text:
                return _skipped("missing_english_translation")

            def action():
                x_id = publish_to_x(english_text, english_media_items)
                return {"ok": bool(x_id), "id": x_id}

            return _publish_guarded("x", action)

        def publish_bluesky_task(english_future):
            if not (ENABLE_BLUESKY and BLUESKY_APP_PASSWORD and plan_target_enabled(plan, "bluesky", True)):
                return {"ok": False, "skipped": True}
            log("Async target start: bluesky")
            english_text, english_media_items = get_english_context(english_future)
            if not english_text:
                return {"ok": False, "skipped": True, "reason": "missing_english_translation"}
            try:
                canonical_url = (plan or {}).get("url_en") or (plan or {}).get("canonical_url")
                result = publish_to_bluesky(english_text, english_media_items, canonical_url)
                uri = result.get("id")
                url = result.get("url") or bluesky_public_url(uri)
                if not result.get("ok") or not uri:
                    result.setdefault("url", url)
                    result.setdefault("error", "bluesky_publish_failed")
                    result.setdefault("retryable", True)
                    return result
                visible, reason = verify_bluesky_root_visible(uri)
                if not visible:
                    result["ok"] = False
                    result["error"] = f"bluesky_visibility_failed:{reason}"
                    result["retryable"] = True
                    return result
                result["url"] = url
                result["retryable"] = False
                return result
            except Exception as exc:
                log(f"Error crossposting to Bluesky: {exc}")
                return {"ok": False, "error": str(exc)}

        def publish_mastodon_task(english_future):
            if not _target_allowed(plan, "mastodon", ENABLE_MASTODON, MASTODON_ACCESS_TOKEN):
                return _skipped()
            english_text, english_media_items = get_english_context(english_future)
            if not english_text:
                return _skipped("missing_english_translation")

            def action():
                canonical_url = (plan or {}).get("url_en") or (plan or {}).get("canonical_url")
                return publish_to_mastodon(english_text, english_media_items, canonical_url)

            return _publish_guarded("mastodon", action)

        def publish_devto_task(english_future):
            if not _target_allowed(plan, "devto", ENABLE_DEVTO, DEVTO_API_KEY):
                return _skipped()
            english_text, english_media_items = get_english_context(english_future)
            if not english_text:
                return _skipped("missing_english_translation")

            def action():
                # For dev.to we post the full English text as markdown article
                # canonical_url is extracted from the plan if available
                canonical_url = (plan or {}).get("url_en") or (plan or {}).get("canonical_url")
                title = (plan or {}).get("title_en") or english_text.split("\n")[0][:100]
                tags = (plan or {}).get("tags") or ["devops", "ai", "technology"]
                url = publish_to_devto(
                    title=title,
                    body_markdown=english_text,
                    canonical_url=canonical_url,
                    tags=tags,
                    main_image=_first_public_image_url(english_media_items),
                )
                return {"ok": bool(url), "id": url}

            return _publish_guarded("devto", action)

        def publish_github_en_task(english_future):
            if not (ENABLE_GITHUB_EN and GITHUB_DISCUSSIONS_TOKEN and plan_target_enabled(plan, "github_en", True)):
                return {"ok": False, "skipped": True}
            log("Async target start: github_en")
            english_text, english_media_items = get_english_context(english_future)
            if not english_text:
                return {"ok": False, "skipped": True, "reason": "missing_english_translation"}
            try:
                title = (plan or {}).get("title_en") or english_text.split("\n")[0][:100]
                article_url = (plan or {}).get("url_en") or (plan or {}).get("canonical_url")
                body = english_text

                # Append images to body
                if english_media_items:
                    img_markdown = ""
                    for item in english_media_items:
                        if item.get("vps_url"):
                            img_markdown += f"\n\n![Image]({item['vps_url']})"
                    body += img_markdown

                if article_url:
                    body += f"\n\n---\n🔗 Read the full post on [alexgetman.com]({article_url})"

                # Append Giscus strict mapping hash
                import hashlib
                title_hash = hashlib.sha1(title.encode("utf-8")).hexdigest()
                body += f"\n\n<!-- sha1: {title_hash} -->"

                url = publish_to_github_discussion(title, body)
                return {"ok": bool(url), "id": url, "url": url}
            except Exception as exc:
                log(f"Error posting to GitHub EN Discussions: {exc}")
                return {"ok": False, "error": str(exc)}

        def publish_github_ru_task():
            if not (ENABLE_GITHUB_RU and GITHUB_DISCUSSIONS_TOKEN and plan_target_enabled(plan, "github_ru", True)):
                return {"ok": False, "skipped": True}
            log("Async target start: github_ru")
            try:
                title = (plan or {}).get("title_ru") or text.split("\n")[0][:100]
                article_url = (plan or {}).get("url_ru")
                body = text

                # Append images to body
                if media_items:
                    img_markdown = ""
                    for item in media_items:
                        if item.get("vps_url"):
                            img_markdown += f"\n\n![Image]({item['vps_url']})"
                    body += img_markdown

                if article_url:
                    body += f"\n\n---\n🔗 Читать статью полностью на [alexgetman.com]({article_url})"

                # Append Giscus strict mapping hash
                import hashlib
                title_hash = hashlib.sha1(title.encode("utf-8")).hexdigest()
                body += f"\n\n<!-- sha1: {title_hash} -->"

                url = publish_to_github_discussion(title, body)
                return {"ok": bool(url), "id": url, "url": url}
            except Exception as exc:
                log(f"Error posting to GitHub RU Discussions: {exc}")
                return {"ok": False, "error": str(exc)}

        def publish_telegram_stories_task():
            if not plan_target_enabled(plan, "telegram_stories", True):
                return _skipped()

            def action():
                return publish_telegram_story(media_items, caption=text, link_url=(plan or {}).get("url_ru"))

            return _publish_guarded("telegram_stories", action)

        def publish_instagram_stories_task(english_future):
            if not _target_allowed(plan, "instagram_stories", ENABLE_INSTAGRAM_STORIES, INSTAGRAM_EN_ACCESS_TOKEN, INSTAGRAM_EN_USER_ID):
                return _skipped()
            english_text, english_media_items = get_english_context(english_future)
            if not english_text:
                return _skipped("missing_english_translation")

            def action():
                return publish_instagram_story(
                    english_media_items,
                    caption=english_text,
                    ig_user_id=INSTAGRAM_EN_USER_ID,
                    token=INSTAGRAM_EN_ACCESS_TOKEN,
                )

            return _publish_guarded("instagram_stories", action)

        def publish_instagram_stories_ru_task():
            if not _target_allowed(plan, "instagram_stories_ru", ENABLE_INSTAGRAM_STORIES, INSTAGRAM_RU_ACCESS_TOKEN, INSTAGRAM_RU_USER_ID):
                return _skipped()

            def action():
                return publish_instagram_story(
                    media_items,
                    caption=text,
                    ig_user_id=INSTAGRAM_RU_USER_ID,
                    token=INSTAGRAM_RU_ACCESS_TOKEN,
                )

            return _publish_guarded("instagram_stories_ru", action)

        futures = {}
        effective_workers = max(PUBLISH_MAX_WORKERS, 6 if english_crosspost_enabled else 2)
        with ThreadPoolExecutor(max_workers=effective_workers) as executor:
            english_future = (
                executor.submit(lambda: (plan or {}).get("text_en"))
                if post_id and english_crosspost_enabled
                else executor.submit(wait_for_english_translation, message_id)
                if english_crosspost_enabled
                else None
            )
            if "threads_ru" in allowed_targets:
                futures[executor.submit(publish_threads_task)] = "threads_ru"
            if "threads_en" in allowed_targets:
                futures[executor.submit(publish_threads_en_task, english_future)] = "threads_en"
            if "facebook" in allowed_targets:
                futures[executor.submit(publish_facebook_task, english_future)] = "facebook"
            if "facebook_ru" in allowed_targets:
                futures[executor.submit(publish_facebook_ru_task)] = "facebook_ru"
            if "linkedin" in allowed_targets:
                futures[executor.submit(publish_linkedin_task, english_future)] = "linkedin"
            if "x" in allowed_targets:
                futures[executor.submit(publish_x_task, english_future)] = "x"
            if "bluesky" in allowed_targets:
                futures[executor.submit(publish_bluesky_task, english_future)] = "bluesky"
            if "mastodon" in allowed_targets:
                futures[executor.submit(publish_mastodon_task, english_future)] = "mastodon"
            if "devto" in allowed_targets:
                futures[executor.submit(publish_devto_task, english_future)] = "devto"
            if "github_en" in allowed_targets:
                futures[executor.submit(publish_github_en_task, english_future)] = "github_en"
            if "github_ru" in allowed_targets:
                futures[executor.submit(publish_github_ru_task)] = "github_ru"
            if "telegram_stories" in allowed_targets:
                futures[executor.submit(publish_telegram_stories_task)] = "telegram_stories"
            if "instagram_stories_ru" in allowed_targets:
                futures[executor.submit(publish_instagram_stories_ru_task)] = "instagram_stories_ru"
            if "instagram_stories" in allowed_targets:
                futures[executor.submit(publish_instagram_stories_task, english_future)] = "instagram_stories"

            for future in as_completed(futures):
                target = futures[future]
                try:
                    result = _normalize_target_result(future.result())
                except Exception as exc:
                    result = {"ok": False, "error": str(exc)}
                target_status[target] = result
                if target == "threads_ru" and result.get("ok"):
                    published_ids = result.get("ids") or []
                log(f"Async target done: {target} -> {json.dumps(result, ensure_ascii=False)}")
    finally:
        # Step 3: Cleanup staged and local files after all async target futures finish.
        keep_remote_files = (
            KEEP_STAGED_MEDIA_FOR_FACEBOOK and (
                target_status.get("facebook", {}).get("ok") or target_status.get("facebook_ru", {}).get("ok")
            )
        ) or "github_en" in allowed_targets or "github_ru" in allowed_targets or "instagram_stories" in allowed_targets or "instagram_stories_ru" in allowed_targets
        for remote_filename in ([] if keep_remote_files else uploaded_files):
            try:
                delete_media_from_vps(remote_filename)
            except Exception as exc:
                log(f"Failed to cleanup VPS file {remote_filename}: {exc}")
        if keep_remote_files:
            log("Keeping staged media on VPS (Facebook async fetch or GitHub link requirement).")
        # Cleanup local files
        for lf in local_files_to_cleanup:
            try:
                if lf.exists():
                    lf.unlink()
            except Exception as exc:
                log(f"Failed to cleanup local file {lf}: {exc}")
                
    return {"published_ids": published_ids, "targets": target_status}
