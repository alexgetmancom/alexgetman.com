from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

from posting_core.http_client import request
from posting_core.time_utils import now_iso
from site_feed.config import (
    BOT_SOURCE_POLL_SECONDS,
    FEED_JSON,
    INDEXNOW_KEY_FILE,
    INDEXNOW_STATE_JSON,
    PIPELINE_DB,
    PUBLIC_BASE_URL,
    PUBLIC_CONTENT_INDEX_JSON,
    PUBLIC_CONTENT_MEMORY_MD,
    PUBLIC_FEED_JSON,
    RENDER_ASYNC_ENABLED,
    RENDER_EVENT,
    RENDER_LOCK,
    SITE_ROOT,
    atomic_write,
    log,
    public_url_host,
    site_url,
)
from site_feed.feed_store import load_feed
from posting_core.db import connect
from site_feed.site_jobs import claim_site_jobs, complete_site_jobs, enqueue_site_job, fail_site_jobs

def publish_public_feed(text=None):
    if text is None:
        if not FEED_JSON.exists():
            return
        text = FEED_JSON.read_text(encoding="utf-8")
    atomic_write(PUBLIC_FEED_JSON, text, permissions=0o664)


def publish_content_index():
    with connect(PIPELINE_DB) as conn:
        memory = [
            dict(row)
            for row in conn.execute(
                """
                SELECT p.post_id, p.updated_at,
                       ru.slug AS slug_ru, ru.text AS text_ru, ru.site_enabled AS has_ru,
                       en.slug AS slug_en, en.text AS text_en, en.site_enabled AS has_en
                FROM publications p
                LEFT JOIN post_locales ru ON ru.post_id=p.post_id AND ru.locale='ru'
                LEFT JOIN post_locales en ON en.post_id=p.post_id AND en.locale='en'
                WHERE p.status='published'
                ORDER BY p.post_id DESC
                LIMIT 200
                """
            )
        ]
    items = []
    for row in memory:
        post_id = int(row.get("post_id") or 0)
        title = ((row.get("text_en") or row.get("text_ru") or "").splitlines() or ["Post"])[0]
        items.append({
            "post_id": post_id,
            "title": title,
            "url_ru": site_url(f"/ru/{post_id}/{row.get('slug_ru')}/") if row.get("has_ru") else None,
            "url_en": site_url(f"/{post_id}/{row.get('slug_en')}/") if row.get("has_en") else None,
            "updated_at": row.get("updated_at"),
        })
    payload = {
        "updated_at": now_iso(),
        "brand": "alexgetmancom",
        "site": PUBLIC_BASE_URL,
        "items": items,
    }
    atomic_write(PUBLIC_CONTENT_INDEX_JSON, json.dumps(payload, ensure_ascii=False, indent=2) + "\n", permissions=0o664)
    lines = [
        "# AlexGetman Content Memory",
        "",
        f"Updated: {payload['updated_at']}",
        "",
    ]
    for item in items[:80]:
        lines.append(f"## {item['post_id']} - {item.get('title') or 'Post'}")
        if item.get("url_ru"):
            lines.append(f"RU: {item['url_ru']}")
        if item.get("url_en"):
            lines.append(f"EN: {item['url_en']}")
        lines.append("")
    atomic_write(PUBLIC_CONTENT_MEMORY_MD, "\n".join(lines).rstrip() + "\n", permissions=0o664)


def indexnow_key():
    if INDEXNOW_KEY_FILE.exists():
        key = INDEXNOW_KEY_FILE.read_text(encoding="utf-8").strip()
        if re.fullmatch(r"[A-Fa-f0-9-]{8,128}", key):
            return key
    key = secrets.token_hex(16)
    atomic_write(INDEXNOW_KEY_FILE, key + "\n", permissions=0o664)
    return key


def ping_indexnow(urls):
    if os.environ.get("INDEXNOW_ENABLED", "1").lower() in {"0", "false", "no"}:
        return
    key = indexnow_key()
    atomic_write(SITE_ROOT / f"{key}.txt", key + "\n", permissions=0o664)
    urls = sorted(dict.fromkeys(urls))
    digest = hashlib.sha256("\n".join(urls).encode("utf-8")).hexdigest()
    state = {}
    if INDEXNOW_STATE_JSON.exists():
        try:
            state = json.loads(INDEXNOW_STATE_JSON.read_text(encoding="utf-8"))
        except Exception:
            state = {}
    if state.get("last_digest") == digest:
        return
    state = {"last_digest": digest, "last_attempt_at": now_iso(), "url_count": len(urls)}
    atomic_write(INDEXNOW_STATE_JSON, json.dumps(state, ensure_ascii=False, indent=2) + "\n", permissions=0o664)
    payload = {
        "host": public_url_host(),
        "key": key,
        "keyLocation": site_url(f"/{key}.txt"),
        "urlList": urls[:100],
    }
    try:
        response = request(
            "https://api.indexnow.org/indexnow",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
            timeout=8,
        )
        state["last_status"] = response.status
        state["last_success_at"] = now_iso()
        atomic_write(INDEXNOW_STATE_JSON, json.dumps(state, ensure_ascii=False, indent=2) + "\n", permissions=0o664)
        log(f"IndexNow ping: {response.status}, urls: {len(payload['urlList'])}")
    except Exception as exc:
        log(f"IndexNow пропущен после ошибки: {exc}")


def run_astro_build():
    project_root = Path(os.environ.get("SOURCE_INDEX", "/home/deploy/repos/ialexey-web/index.html")).parent
    
    log(f"Запуск сборки Astro в директории: {project_root}")
    env = os.environ.copy()
    if sys.platform != "win32":
        env["PATH"] = "/usr/bin:/usr/local/bin:/opt/homebrew/bin:" + env.get("PATH", "")
        
    try:
        for path in (project_root / "dist", project_root / ".astro"):
            if path.exists():
                shutil.rmtree(path)
        res = subprocess.run(
            ["bun", "run", "build"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            env=env,
            timeout=int(os.environ.get("ASTRO_BUILD_TIMEOUT_SECONDS", "300")),
        )
        if res.returncode != 0:
            log(f"Ошибка сборки Astro: {res.stderr}")
            return False, res.stderr.strip() or res.stdout.strip() or f"bun build exited {res.returncode}"
            
        log("Сборка Astro успешно завершена.")
        
        dist_dir = project_root / "dist"
        site_root = Path(os.environ.get("SITE_ROOT", "/home/deploy/ialexey-web"))
        
        if dist_dir.exists() and site_root.exists() and dist_dir.resolve() != site_root.resolve():
            log(f"Синхронизация собранных файлов из {dist_dir} в {site_root}...")
            sync_res = subprocess.run(
                ["rsync", "-a", "--delete", "--exclude", "media", "--exclude", "stats", "--exclude", "feed", "--exclude", "bin", f"{dist_dir}/", f"{site_root}/"],
                capture_output=True,
                text=True
            )
            if sync_res.returncode == 0:
                log("Синхронизация завершена успешно.")
            else:
                log(f"Ошибка синхронизации: {sync_res.stderr}")
                return False, sync_res.stderr.strip() or f"rsync exited {sync_res.returncode}"
        return True, None
    except subprocess.TimeoutExpired as exc:
        log(f"Таймаут сборки Astro: {exc}")
        return False, f"astro build timeout after {exc.timeout}s"
    except Exception as exc:
        log(f"Исключение при сборке Astro: {exc}")
        return False, str(exc)


def render_site(items=None):
    items = items if items is not None else load_feed()
    publish_public_feed()
    ok, error = run_astro_build()
    if not ok:
        return False, error
    publish_content_index()
    
    # Пинг поисковых систем через IndexNow
    try:
        urls = [site_url("/"), site_url("/feed.xml"), site_url("/llms.txt")]
        for item in items:
            if item.get("has_en"):
                urls.append(site_url(f"/{int(item['post_id'])}/{item['slug_en']}/"))
            if item.get("has_ru"):
                urls.append(site_url(f"/ru/{int(item['post_id'])}/{item['slug_ru']}/"))
        ping_indexnow(urls)
    except Exception as exc:
        log(f"Ошибка IndexNow: {exc}")
    return True, None


def request_render(items=None, message_id: int = 0, post_id: int = 0, reason: str = "render"):
    if not RENDER_ASYNC_ENABLED:
        return render_site(items)
    enqueue_site_job(message_id=message_id, post_id=post_id, reason=reason)
    publish_public_feed()
    RENDER_EVENT.set()
    return True, None


def render_worker():
    while True:
        RENDER_EVENT.wait(BOT_SOURCE_POLL_SECONDS)
        RENDER_EVENT.clear()
        with RENDER_LOCK:
            jobs = claim_site_jobs()
            if not jobs:
                continue
            try:
                from site_feed.bot_source import sync_bot_source
                sync_bot_source()
                ok, error = render_site(load_feed())
                if ok:
                    complete_site_jobs(jobs)
                else:
                    fail_site_jobs(jobs, error or "site build failed")
            except Exception as exc:
                fail_site_jobs(jobs, str(exc))
