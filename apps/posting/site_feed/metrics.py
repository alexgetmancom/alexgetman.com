from __future__ import annotations

import html
import json
import re
import sqlite3
from datetime import datetime
from zoneinfo import ZoneInfo

from site_feed.config import METRICS_LOCK, PIPELINE_DB, now_iso
from site_feed.feed_store import load_metrics, save_metrics

def metrics_day():
    return datetime.now(ZoneInfo("Europe/Moscow")).strftime("%Y-%m-%d")


def normalize_metric_path(value):
    path = str(value or "/").strip()
    path = path.split("#", 1)[0].split("?", 1)[0]
    if not path.startswith("/") or path.startswith("//"):
        path = "/"
    if len(path) > 180:
        path = path[:180]
    if not re.fullmatch(r"/[A-Za-z0-9А-Яа-яЁё._~!$&'()*+,;=:@%/-]*", path):
        path = "/"
    return path or "/"


def record_pageview(path):
    path = normalize_metric_path(path)
    day = metrics_day()
    with METRICS_LOCK:
        data = load_metrics()
        data["total"] = int(data.get("total") or 0) + 1
        day_bucket = data.setdefault("days", {}).setdefault(day, {"total": 0, "paths": {}})
        day_bucket["total"] = int(day_bucket.get("total") or 0) + 1
        paths = day_bucket.setdefault("paths", {})
        paths[path] = int(paths.get(path) or 0) + 1
        save_metrics(data)
    sync_pageview_to_pipeline(path)
    return path


def _candidate_paths(path: str) -> list[str]:
    paths = [path]
    if path.endswith("/"):
        paths.append(path.rstrip("/"))
    else:
        paths.append(path + "/")
    return list(dict.fromkeys(paths))


def sync_pageview_to_pipeline(path: str) -> None:
    if not PIPELINE_DB.exists():
        return
    candidates = _candidate_paths(path)
    placeholders = ",".join("?" for _ in candidates)
    try:
        conn = sqlite3.connect(str(PIPELINE_DB), timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                f"""
                SELECT post_key, 'site_ru' AS target FROM posts WHERE site_ru_path IN ({placeholders})
                UNION ALL
                SELECT post_key, 'site_en' AS target FROM posts WHERE site_en_path IN ({placeholders})
                LIMIT 1
                """,
                tuple(candidates + candidates),
            ).fetchone()
            if not row:
                return
            sampled_at = now_iso()
            existing = conn.execute(
                "SELECT value FROM post_metrics WHERE post_key=? AND target=? AND metric_name='views'",
                (row["post_key"], row["target"]),
            ).fetchone()
            value = int(existing["value"] or 0) + 1 if existing else 1
            raw_json = json.dumps({"path": path}, ensure_ascii=False)
            conn.execute(
                """
                INSERT INTO post_metrics(post_key, target, metric_name, value, source, sampled_at, error, raw_json)
                VALUES (?, ?, 'views', ?, 'site_pageview_endpoint', ?, NULL, ?)
                ON CONFLICT(post_key, target, metric_name) DO UPDATE SET
                    value=excluded.value,
                    source=excluded.source,
                    sampled_at=excluded.sampled_at,
                    error=NULL,
                    raw_json=excluded.raw_json
                """,
                (row["post_key"], row["target"], value, sampled_at, raw_json),
            )
            conn.execute(
                "INSERT INTO metric_samples(post_key, target, metric_name, value, sampled_at, source, raw_json) VALUES (?, ?, 'views', ?, ?, 'site_pageview_endpoint', ?)",
                (row["post_key"], row["target"], value, sampled_at, raw_json),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        return


def metrics_dashboard():
    data = load_metrics()
    days = data.get("days", {})
    ordered_days = sorted(days.keys(), reverse=True)
    today = metrics_day()
    today_total = int(days.get(today, {}).get("total") or 0)
    last_7_total = sum(int(days.get(day, {}).get("total") or 0) for day in ordered_days[:7])
    all_paths = {}
    for day_data in days.values():
        for path, count in day_data.get("paths", {}).items():
            all_paths[path] = all_paths.get(path, 0) + int(count or 0)
    top_paths = sorted(all_paths.items(), key=lambda item: item[1], reverse=True)[:20]

    day_rows = "\n".join(
        f"<tr><td>{html.escape(day)}</td><td>{int(days[day].get('total') or 0)}</td></tr>"
        for day in ordered_days[:30]
    )
    path_rows = "\n".join(
        f"<tr><td>{html.escape(path)}</td><td>{count}</td></tr>"
        for path, count in top_paths
    )
    updated = html.escape(data.get("updated_at") or "нет данных")
    return f"""<!doctype html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>iAlexey metrics</title>
    <style>
        body {{ margin: 0; padding: 32px; background: #0d1117; color: #c9d1d9; font: 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
        main {{ max-width: 920px; margin: 0 auto; }}
        h1, h2 {{ color: #fff; }}
        .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 24px 0; }}
        .stat, table {{ border: 1px solid #30363d; background: #161b22; border-radius: 8px; }}
        .stat {{ padding: 16px; }}
        .value {{ display: block; margin-top: 8px; color: #58a6ff; font-size: 28px; font-weight: 700; }}
        table {{ width: 100%; border-collapse: collapse; overflow: hidden; }}
        th, td {{ padding: 10px 12px; border-bottom: 1px solid #30363d; text-align: left; }}
        th {{ color: #8b949e; font-weight: 600; }}
        tr:last-child td {{ border-bottom: 0; }}
        .note {{ color: #8b949e; margin-top: 24px; }}
    </style>
</head>
<body>
<main>
    <h1>iAlexey metrics</h1>
    <div class="grid">
        <div class="stat">Всего просмотров<span class="value">{int(data.get("total") or 0)}</span></div>
        <div class="stat">Сегодня<span class="value">{today_total}</span></div>
        <div class="stat">Последние 7 дней<span class="value">{last_7_total}</span></div>
    </div>
    <h2>Дни</h2>
    <table><thead><tr><th>Дата MSK</th><th>Pageviews</th></tr></thead><tbody>{day_rows}</tbody></table>
    <h2>Страницы</h2>
    <table><thead><tr><th>Path</th><th>Pageviews</th></tr></thead><tbody>{path_rows}</tbody></table>
    <p class="note">Обновлено: {updated}. Хранятся только агрегированные счетчики по дню и path. IP, user-agent, cookies, referrer, fingerprint и visitor ID не сохраняются.</p>
</main>
<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  document.querySelectorAll('input[name="token"]').forEach((input) => input.value = token);
</script>
</body>
</html>
"""
