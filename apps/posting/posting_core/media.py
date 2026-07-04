from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.request
from pathlib import Path

from posting_core.clients.telegram import get_telegram_file_url
from posting_core.publish_config import (
    CONTROLLER_BOT_TOKEN,
    MEDIA_CLEANUP_INTERVAL_SECONDS,
    PUBLIC_MEDIA_BASE_URL,
    REMOTE_MEDIA_PATH,
    STAGED_MEDIA_MAX_AGE_SECONDS,
    TEMP_MEDIA_DIR,
    TEMP_MEDIA_MAX_AGE_SECONDS,
    log,
)

LAST_MEDIA_CLEANUP_AT = 0.0

def cleanup_temp_media():
    try:
        TEMP_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        now = time.time()
        for path in TEMP_MEDIA_DIR.iterdir():
            if not path.is_file():
                continue
            if now - path.stat().st_mtime > TEMP_MEDIA_MAX_AGE_SECONDS:
                path.unlink()
                log(f"Removed stale temp media {path}")
    except Exception as exc:
        log(f"Warning: temp media cleanup failed: {exc}")


def cleanup_staged_media():
    if ":" in REMOTE_MEDIA_PATH:
        return
    try:
        root = Path(REMOTE_MEDIA_PATH)
        if not root.exists():
            return
        now = time.time()
        for path in root.iterdir():
            if not path.is_file():
                continue
            if not re.match(r"^\d+_", path.name):
                continue
            if now - path.stat().st_mtime > STAGED_MEDIA_MAX_AGE_SECONDS:
                path.unlink()
                log(f"Removed stale staged media {path.name}")
    except Exception as exc:
        log(f"Warning: staged media cleanup failed: {exc}")


def maybe_cleanup_media(force=False):
    global LAST_MEDIA_CLEANUP_AT
    now = time.time()
    if not force and now - LAST_MEDIA_CLEANUP_AT < MEDIA_CLEANUP_INTERVAL_SECONDS:
        return
    LAST_MEDIA_CLEANUP_AT = now
    cleanup_temp_media()
    cleanup_staged_media()


def probe_video_dimensions(input_path):
    cmd = [
        "ffprobe",
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "json",
        str(input_path),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise Exception(f"ffprobe failed: {res.stderr[-2000:]}")
    streams = json.loads(res.stdout or "{}").get("streams") or []
    if not streams:
        raise Exception("ffprobe did not find a video stream")
    return int(streams[0]["width"]), int(streams[0]["height"])


def threads_video_bounds(width, height):
    if width > height:
        return 1920, 1080
    if height > width:
        return 1080, 1920
    return 1080, 1080


def normalize_video_for_threads(input_path):
    """Return a Threads-ready MP4, scaling only when dimensions exceed orientation bounds."""
    width, height = probe_video_dimensions(input_path)
    max_width, max_height = threads_video_bounds(width, height)
    TEMP_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    output_path = TEMP_MEDIA_DIR / f"threads_{int(time.time())}_{input_path.stem}.mp4"

    if width <= max_width and height <= max_height:
        log(f"Video already within Threads bounds: {width}x{height}; remuxing for faststart")
        cmd = [
            "ffmpeg",
            "-y",
            "-i", str(input_path),
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-c", "copy",
            "-movflags", "+faststart",
            str(output_path),
        ]
    else:
        vf = f"scale='min({max_width},iw)':'min({max_height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p"
        log(f"Scaling video for Threads: {width}x{height} -> within {max_width}x{max_height}")
        cmd = [
            "ffmpeg",
            "-y",
            "-threads", "2",
            "-i", str(input_path),
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-vf", vf,
            "-c:v", "libx264",
            "-threads", "2",
            "-preset", "veryfast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k",
            "-ar", "48000",
            "-ac", "2",
            "-movflags", "+faststart",
            str(output_path),
        ]

    log(f"Preparing video for Threads: {input_path.name} -> {output_path.name}")
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise Exception(f"ffmpeg failed: {res.stderr[-2000:]}")
    new_width, new_height = probe_video_dimensions(output_path)
    log(f"Prepared video: {new_width}x{new_height}, {output_path.stat().st_size} bytes")
    return output_path


def upload_media_to_vps(local_path, remote_filename):
    if ":" in REMOTE_MEDIA_PATH:
        raise Exception("REMOTE_MEDIA_PATH must be a local mounted path; SCP mode is no longer supported")
    import shutil
    dest_dir = Path(REMOTE_MEDIA_PATH)
    dest_path = dest_dir / remote_filename
    log(f"Copying {local_path.name} to local path {dest_path}...")
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(local_path, dest_path)
        dest_path.chmod(0o644)
    except Exception as exc:
        raise Exception(f"Local copy failed: {exc}")


def delete_media_from_vps(remote_filename):
    if ":" in REMOTE_MEDIA_PATH:
        log("Skipping cleanup because SCP mode is unsupported")
        return
    dest_path = Path(REMOTE_MEDIA_PATH) / remote_filename
    log(f"Removing {remote_filename} from local path {dest_path}...")
    try:
        if dest_path.exists():
            dest_path.unlink()
    except Exception as exc:
        log(f"Warning: Failed to delete local media {remote_filename}: {exc}")


def plan_media_to_items(plan):
    media = (plan or {}).get("media_en")
    if not media:
        return []
    raw_items = media if isinstance(media, list) else [media]
    items = []
    for item in raw_items:
        file_id = item.get("file_id")
        local_path = item.get("local_path") or item.get("path")
        media_type = item.get("type")
        if (not file_id and not local_path) or media_type not in ("photo", "video", "IMAGE", "VIDEO"):
            continue
        item_type = "VIDEO" if media_type in ("video", "VIDEO") else "IMAGE"
        normalized = {"type": item_type, "token": CONTROLLER_BOT_TOKEN}
        if file_id:
            normalized["file_id"] = file_id
        if local_path:
            normalized["local_path"] = local_path
        for key in ("story_local_path", "story_width", "story_height"):
            if item.get(key):
                normalized[key] = item[key]
        items.append(normalized)
    return items


def _safe_media_name(value):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value)).strip("_")[:120] or "media"


def prepare_crosspost_media_items(source_items, uploaded_files, local_files_to_cleanup, filename_prefix="crosspost"):
    prepared = []
    for i, item in enumerate(source_items):
        item_type = item["type"]
        ext = ".mp4" if item_type == "VIDEO" else ".jpg"
        local_source = item.get("local_path") or item.get("path")
        file_id = item.get("file_id")
        source_name = _safe_media_name(file_id or local_source or f"{filename_prefix}_{i}")
        if local_source:
            local_path = Path(local_source)
            log(f"Using local custom {item_type.lower()} file for crosspost: {local_path}")
        else:
            telegram_file = get_telegram_file_url(file_id, token=item.get("token"))
            if not telegram_file:
                log(f"Failed to get file URL from Telegram for crosspost file_id: {file_id}")
                continue

            temp_download = not os.path.isabs(telegram_file)
            if temp_download:
                TEMP_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
                local_path = TEMP_MEDIA_DIR / f"{filename_prefix}_{source_name}{ext}"
                log(f"Downloading custom {item_type.lower()} from Telegram for EN crosspost...")
                urllib.request.urlretrieve(telegram_file, local_path)
                local_files_to_cleanup.append(local_path)
            else:
                local_path = Path(telegram_file)
                log(f"Using local Telegram custom {item_type.lower()} file for EN crosspost: {local_path}")

        upload_path = local_path
        if item_type == "VIDEO":
            normalized_path = normalize_video_for_threads(local_path)
            upload_path = normalized_path
            local_files_to_cleanup.append(normalized_path)

        remote_filename = f"{int(time.time())}_{filename_prefix}_{i}_{source_name}{ext}"
        upload_media_to_vps(upload_path, remote_filename)
        uploaded_files.append(remote_filename)

        prepared_item = dict(item)
        prepared_item["vps_url"] = f"{PUBLIC_MEDIA_BASE_URL}/{remote_filename}"
        prepared_item["local_path"] = upload_path
        story_local_path = item.get("story_local_path")
        if story_local_path and item_type == "IMAGE":
            story_source = Path(story_local_path)
            story_remote_filename = f"{int(time.time())}_{filename_prefix}_{i}_{source_name}_story.jpg"
            upload_media_to_vps(story_source, story_remote_filename)
            uploaded_files.append(story_remote_filename)
            prepared_item["story_vps_url"] = f"{PUBLIC_MEDIA_BASE_URL}/{story_remote_filename}"
            prepared_item["story_local_path"] = story_source
            prepared_item["story_width"] = item.get("story_width")
            prepared_item["story_height"] = item.get("story_height")
        prepared.append(prepared_item)
    return prepared
