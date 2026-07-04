from __future__ import annotations

import html
from datetime import datetime
from fastapi import Request

from zoneinfo import ZoneInfo
from posting_core.targets import TARGETS
from site_feed.config import truncate_text, parse_date
from site_feed.ops_dashboard import command_center_payload
from site_feed.pipeline import (
    pipeline_status_payload,
    target_cell,
    format_metric_value,
    get_target_metric,
    get_week_bounds,
)

def _esc(value) -> str:
    return html.escape(str(value if value is not None else ""))


def _active_tab(request: Request) -> str:
    tab = request.query_params.get("tab") or "pipeline"
    return tab if tab in {"pipeline", "repair", "queue", "credentials", "diagnostics"} else "pipeline"


def _nav(tab: str) -> str:
    labels = {
        "pipeline": "Pipeline",
        "repair": "Repair",
        "queue": "Queue",
        "credentials": "Credentials",
        "diagnostics": "Diagnostics",
    }
    links = []
    for key, label in labels.items():
        cls = "active" if key == tab else ""
        links.append(f'<a class="{cls}" href="/command-center?tab={key}">{label}</a>')
    return "".join(links)


def _format_media(post) -> str:
    count = int(post.get("media_count") or 0)
    if count == 0:
        return "text"
    media_types = post.get("media_types") or []
    mtype = "vid" if "video" in media_types else "pic"
    return f"{mtype} ({count})"


ORDERED_IDS = [
    "site_en", "site_ru",
    "threads_en", "threads_ru",
    "facebook", "facebook_ru",
    "instagram_stories", "instagram_stories_ru",
    "telegram", "linkedin", "x",
    "telegram_stories",
    "bluesky", "mastodon", "devto",
    "github_en", "github_ru",
]
ORDERED_TARGETS = []
_target_map = {t.id: t for t in TARGETS}
for _tid in ORDERED_IDS:
    if _tid in _target_map:
        ORDERED_TARGETS.append(_target_map[_tid])


_PLATFORM_ICONS = {
    "site": """<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>""",
    "threads": """<svg viewBox="0 0 192 192" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M141.537 88.9883C140.71 88.5919 139.87 88.2104 139.019 87.8451C137.537 60.5382 122.616 44.905 97.5619 44.745C97.4484 44.7443 97.3355 44.7443 97.222 44.7443C82.2364 44.7443 69.7731 51.1409 62.102 62.7807L75.881 72.2328C81.6116 63.5383 90.6052 61.6848 97.2286 61.6848C97.3051 61.6848 97.3819 61.6848 97.4576 61.6855C105.707 61.7381 111.932 64.1366 115.961 68.814C118.893 72.2193 120.854 76.925 121.825 82.8638C114.511 81.6207 106.601 81.2385 98.145 81.7233C74.3247 83.0954 59.0111 96.9879 60.0396 116.292C60.5615 126.084 65.4397 134.508 73.775 140.011C80.8224 144.663 89.899 146.938 99.3323 146.423C111.79 146.423 121.563 140.987 128.381 132.296C133.559 125.696 136.834 117.143 138.28 106.366C144.217 109.949 148.617 114.664 151.047 120.332C155.179 129.967 155.42 145.8 142.501 158.708C131.182 170.016 117.576 174.908 97.0135 175.059C74.2042 174.89 56.9538 167.575 45.7381 153.317C35.2355 139.966 29.8077 120.682 29.6052 96C29.8077 71.3178 35.2355 52.0336 45.7381 38.6827C56.9538 24.4249 74.2039 17.11 97.0132 16.9405C119.988 17.1113 137.539 24.4614 149.184 38.788C154.894 45.8136 159.199 54.6488 162.037 64.9503L178.184 60.6422C174.744 47.9622 169.331 37.0357 161.965 27.974C147.036 9.60668 125.202 0.195148 97.0695 0H96.9569C68.8816 0.19447 47.2921 9.6418 32.7883 28.0793C19.8819 44.4864 13.2244 67.3157 13.0007 95.9325L13 96L13.0007 96.0675C13.2244 124.684 19.8819 147.514 32.7883 163.921C47.2921 182.358 68.8816 191.806 96.9569 192H97.0695C122.03 191.827 139.624 185.292 154.118 170.811C173.081 151.866 172.51 128.119 166.26 113.541C161.776 103.087 153.227 94.5962 141.537 88.9883ZM98.4405 129.507C88.0005 130.095 77.1544 125.409 76.6196 115.372C76.2232 107.93 81.9158 99.626 99.0812 98.6368C101.047 98.5234 102.976 98.468 104.871 98.468C111.106 98.468 116.939 99.0737 122.242 100.233C120.264 124.935 108.662 128.946 98.4405 129.507Z"/></svg>""",
    "facebook": """<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c4.56-.93 8-4.96 8-9.75z"></path></svg>""",
    "telegram": """<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.11.02-1.93 1.23-5.46 3.62-.51.35-.98.53-1.39.51-.46-.01-1.35-.26-2.01-.48-.8-.27-1.44-.42-1.39-.89.03-.25.38-.51 1.06-.78 4.15-1.81 6.91-3 8.28-3.57 3.94-1.63 4.76-1.91 5.3-.13z"></path></svg>""",
    "telegram_stories": """<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 2 14.9 8.3 22 9.1l-5.3 4.7 1.5 6.9L12 17.2 5.8 20.7l1.5-6.9L2 9.1l7.1-.8L12 2Z"></path></svg>""",
    "instagram": """<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"></circle></svg>""",
    "linkedin": """<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"></path></svg>""",
    "x": """<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path></svg>""",
    "bluesky": """<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 12.7c-1.1-2.1-4.1-6-6.9-7.9C2.4 3 .7 3.3.2 4.2-.3 5.1.1 8.8.5 9.9c.8 2.7 3.7 3.6 6.3 3.2-4.5.7-8.5 2.5-3.2 8.4 5.9 6.1 8.1-1.3 8.4-5.1.3 3.8 2.5 11.2 8.4 5.1 5.3-5.9 1.3-7.7-3.2-8.4 2.6.4 5.5-.5 6.3-3.2.4-1.1.8-4.8.3-5.7-.5-.9-2.2-1.2-4.9.6-2.8 1.9-5.8 5.8-6.9 7.9Z"/></svg>""",
    "mastodon": """<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M20.9 8.1c0-4.2-2.8-5.4-2.8-5.4C16.7 2 14.3 2 12 2h-.1c-2.3 0-4.7 0-6.1.7 0 0-2.8 1.2-2.8 5.4 0 1 0 2.2.1 3.4.4 4.1 3 5.1 5.7 5.5 1.4.2 2.6.2 3.2.2 1.1-.1 1.8-.3 1.8-.3l-.1-1.9s-.8.3-1.7.4c-1.7.1-3.4-.2-3.7-2.1h8.4c.1 0 2.6-.1 3-3 .1-.6.2-1.3.2-2.2Zm-3.6 2.4h-2.4V7.7c0-.6-.3-1-1-1s-1.1.4-1.1 1v2.8h-2.4V7.7c0-.6-.3-1-1-1s-1.1.4-1.1 1v2.8H5.9V7.6c0-2.2 1.4-3.4 3-3.4 1 0 1.8.4 2.3 1.1L12 6l.8-.7c.5-.7 1.3-1.1 2.3-1.1 1.6 0 3 1.2 3 3.4v2.9Z"/></svg>""",
    "devto": """<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M7.8 7.5c-.3-.3-.7-.5-1.2-.5H4v10h2.6c.5 0 .9-.2 1.2-.5.3-.3.5-.8.5-1.3V8.8c0-.5-.2-1-.5-1.3ZM6.5 15H5.8V9h.7v6Zm6.7-6V7h-4v10h4v-2h-2.2v-2h1.7v-2h-1.7V9h2.2Zm4.7 8 2.1-10h-1.9l-1.1 6.2L15.9 7H14l2.1 10h1.8Z"/></svg>""",
    "github": """<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.2.8-.6v-2.1c-3.3.7-4-1.4-4-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 .1.8 2.1 3.4 1.5.1-.8.4-1.4.7-1.7-2.6-.3-5.4-1.3-5.4-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2A11.5 11.5 0 0 1 12 6.8c1 0 2 .1 2.9.4 2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.4 5.9.4.3.8 1 .8 2v3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z"/></svg>"""
}

_TOOL_ICON = """<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>"""

def _platform_key(target_id: str) -> str:
    if target_id.startswith("site_"):
        return "site"
    if target_id.startswith("threads_"):
        return "threads"
    if target_id.startswith("facebook"):
        return "facebook"
    if target_id.startswith("instagram_stories"):
        return "instagram"
    if target_id == "telegram_stories":
        return "telegram_stories"
    if target_id.startswith("github_"):
        return "github"
    return target_id


def _format_day_header_ru(dt: datetime) -> str:
    RU_MONTHS = {
        1: "января", 2: "февраля", 3: "марта", 4: "апреля",
        5: "мая", 6: "июня", 7: "июля", 8: "августа",
        9: "сентября", 10: "октября", 11: "ноября", 12: "декабря"
    }
    return f"{dt.day} {RU_MONTHS[dt.month]} {dt.year}"


def _weekly_chart(posts) -> str:
    metrics = ("views", "likes", "replies")
    colors = {"views": "#58a6ff", "likes": "#f778ba", "replies": "#a5d6ff"}
    labels = {"views": "views", "likes": "likes", "replies": "replies"}
    days = {}
    for post in posts:
        day = parse_date(post["date"]).astimezone(ZoneInfo("Europe/Moscow")).date().isoformat()
        bucket = days.setdefault(day, {metric: 0 for metric in metrics})
        for target in ORDERED_TARGETS:
            for metric in metrics:
                bucket[metric] += get_target_metric(post, target.id, metric)
    if not days:
        return ""
    ordered = sorted(days.items())
    width, height = 980, 138
    left, right, top, bottom = 42, 18, 14, 24
    plot_w, plot_h = width - left - right, height - top - bottom
    max_by_metric = {
        metric: max(max(bucket[metric] for _, bucket in ordered), 1)
        for metric in metrics
    }

    def point(index, metric, value):
        x = left + (plot_w * index / max(1, len(ordered) - 1))
        y = top + plot_h - (plot_h * value / max_by_metric[metric])
        return x, y

    grid = "".join(
        f'<line x1="{left}" y1="{top + plot_h * i / 4:.1f}" x2="{width - right}" y2="{top + plot_h * i / 4:.1f}" class="chart-grid" />'
        for i in range(5)
    )
    lines = []
    points = []
    for metric in metrics:
        metric_points = []
        for i, (day, bucket) in enumerate(ordered):
            x, y = point(i, metric, bucket[metric])
            metric_points.append(f"{x:.1f},{y:.1f}")
            day_values = " · ".join(
                f"{labels[item]}: {format_metric_value(bucket[item])}"
                for item in metrics
            )
            tooltip = f"{day[5:]} · {day_values}"
            points.append(
                f'<circle class="chart-point" cx="{x:.1f}" cy="{y:.1f}" r="2.8" fill="{colors[metric]}" />'
                f'<circle class="chart-hit" cx="{x:.1f}" cy="{y:.1f}" r="10" data-tooltip="{_esc(tooltip)}" />'
            )
        lines.append(f'<polyline class="chart-line" points="{" ".join(metric_points)}" fill="none" stroke="{colors[metric]}" stroke-width="2.2" />')
    x_labels = "".join(
        f'<text x="{point(i, "views", 0)[0]:.1f}" y="{height - 7}" text-anchor="middle">{_esc(day[5:])}</text>'
        for i, (day, _) in enumerate(ordered)
    )
    legend = "".join(
        f'<span><i style="background:{colors[metric]}"></i>{metric}: {format_metric_value(sum(bucket[metric] for _, bucket in ordered))}</span>'
        for metric in metrics
    )
    return f"""
      <div class="metric-chart">
        <div class="metric-chart__legend">{legend}</div>
        <svg viewBox="0 0 {width} {height}" role="img" aria-label="Weekly metrics chart">{grid}{"".join(lines)}{"".join(points)}{x_labels}</svg>
        <div class="chart-tooltip" id="chart-tooltip" hidden></div>
      </div>
    """


def _pipeline_section(request: Request) -> str:
    try:
        week_offset = int(request.query_params.get("week_offset") or 0)
    except ValueError:
        week_offset = 0

    data = pipeline_status_payload(week_offset=week_offset)
    
    start_of_week, end_of_week, _, _ = get_week_bounds(week_offset)
    week_start_str = _format_day_header_ru(start_of_week)
    week_end_str = _format_day_header_ru(end_of_week)

    tab = request.query_params.get("tab") or "pipeline"
    if week_offset > 0:
        next_btn = f'<a class="pag-btn" href="/command-center?tab={tab}&week_offset={week_offset - 1}">Следующая неделя &rarr;</a>'
        current_btn = f'<a class="pag-btn" href="/command-center?tab={tab}&week_offset=0">Текущая неделя</a>'
    else:
        next_btn = '<span class="pag-btn disabled">Следующая неделя &rarr;</span>'
        current_btn = ''
        
    prev_btn = f'<a class="pag-btn" href="/command-center?tab={tab}&week_offset={week_offset + 1}">&larr; Предыдущая неделя</a>'
    
    pagination_bar = f"""
    <div class="pagination-bar">
      {prev_btn}
      {current_btn}
      <span class="pag-current">{week_start_str} &ndash; {week_end_str}</span>
      {next_btn}
    </div>
    """

    # Generate two-row header:
    # Row 1 — platform icons only (no Post/Date/etc)
    # Row 2 — Post/Date/RU/EN/Media/Σ + EN/RU sub-labels + repair
    row1_headers = []
    row2_headers = []
    i = 0
    n = len(ORDERED_TARGETS)
    while i < n:
        target = ORDERED_TARGETS[i]
        pkey = _platform_key(target.id)
        icon = _PLATFORM_ICONS.get(pkey, "")

        if i + 1 < n and _platform_key(ORDERED_TARGETS[i+1].id) == pkey:
            label = {
                "x": "X (Twitter)",
                "github": "GitHub",
                "devto": "dev.to",
            }.get(pkey, pkey.capitalize())
            row1_headers.append(f'<th colspan="2" class="text-center" title="{label}">{icon}</th>')
            row2_headers.append(f'<th class="text-center">{ORDERED_TARGETS[i].locale.upper()}</th>')
            row2_headers.append(f'<th class="text-center">{ORDERED_TARGETS[i+1].locale.upper()}</th>')
            i += 2
        else:
            label = target.label
            row1_headers.append(f'<th class="text-center" title="{label}">{icon}</th>')
            row2_headers.append('<th></th>')  # placeholder under single-locale icon
            i += 1

    target_row1 = "".join(row1_headers)
    target_row2 = "".join(row2_headers)
    total_cols = 6 + len(ORDERED_TARGETS) + 1
    
    # Группируем посты по дням (в MSK)
    days_dict = {}
    for post in data["posts"]:
        dt_msk = parse_date(post["date"]).astimezone(ZoneInfo("Europe/Moscow"))
        post_day = dt_msk.date()
        if post_day not in days_dict:
            days_dict[post_day] = {"day_title": _format_day_header_ru(dt_msk), "posts": []}
        days_dict[post_day]["posts"].append(post)

    def _mspan(v, m):
        text = format_metric_value(v) if v > 0 else ("0" if m == "mv" else "—")
        return f'<span class="{m}">{text}</span>'

    rendered_rows = []
    for post_day, day_info in days_dict.items():
        day_title = day_info["day_title"]
        day_posts = day_info["posts"]

        # Суммы за день по 4 метрикам
        day_m = {m: {t.id: 0 for t in ORDERED_TARGETS} for m in ("views","likes","replies","reposts")}
        day_totals = {m: 0 for m in ("views","likes","replies","reposts")}
        for post in day_posts:
            for target in ORDERED_TARGETS:
                for m in ("views","likes","replies","reposts"):
                    v = get_target_metric(post, target.id, m)
                    day_m[m][target.id] += v
                    day_totals[m] += v

        # Компактный разделитель-заголовок дня — СВЕРХУ
        rendered_rows.append(
            f'<tr class="day-separator">'
            f'<td colspan="{total_cols}"><span class="day-label">{day_title}</span></td>'
            f'</tr>'
        )

        # Строки постов
        for post in day_posts:
            dt_msk = parse_date(post["date"]).astimezone(ZoneInfo("Europe/Moscow"))
            time_str = dt_msk.strftime("%H:%M")
            display_id = _esc(post.get('post_id') or post['message_id'])
            post_link = (
                f"<a href=\"{_esc(post['site_url'])}\">{display_id}</a>"
                if post.get("site_url")
                else display_id
            )
            ptotals = {m: sum(get_target_metric(post, t.id, m) for t in ORDERED_TARGETS) for m in ("views","likes","replies","reposts")}
            sigma = "".join(_mspan(ptotals[m], mm) for m, mm in (("views","mv"),("likes","ml"),("replies","mr"),("reposts","mp")))
            post_row = (
                "<tr>"
                f"<td>{post_link}</td>"
                f"<td class=\"nowrap date-col text-center\">{time_str}</td>"
                f"<td class=\"post-text\" title=\"{_esc(post.get('full_text_ru') or '')}\">{_esc(truncate_text(post.get('full_text_ru') or '', 30))}</td>"
                f"<td class=\"post-text\" title=\"{_esc(post.get('full_text_en') or '')}\">{_esc(truncate_text(post.get('full_text_en') or '', 30))}</td>"
                f"<td>{_esc(_format_media(post))}</td>"
                f"<td class=\"text-center nowrap font-bold\">{sigma}</td>" +
                "".join(f"<td class=\"text-center\">{target_cell(post, target.id)}</td>" for target in ORDERED_TARGETS) +
                f"<td class=\"text-center\"><a href=\"/command-center?tab=repair&ref={_esc(post.get('post_id') or post.get('message_id') or '')}&message_id={_esc(post.get('telegram_message_id') or '')}\" title=\"Repair\">{_TOOL_ICON}</a></td>"
                "</tr>"
            )
            rendered_rows.append(post_row)

        # Строка итогов дня — СНИЗУ
        day_sigma = "".join(_mspan(day_totals[m], mm) for m, mm in (("views","mv"),("likes","ml"),("replies","mr"),("reposts","mp")))
        day_cols = ['<td colspan="4"></td>', '<td></td>', f'<td class="text-center font-bold">{day_sigma}</td>']
        for target in ORDERED_TARGETS:
            cell = "".join(_mspan(day_m[m][target.id], mm) for m, mm in (("views","mv"),("likes","ml"),("replies","mr"),("reposts","mp")))
            day_cols.append(f'<td class="text-center font-bold">{cell}</td>')
        day_cols.append('<td></td>')
        rendered_rows.append(f'<tr class="day-header">{"".join(day_cols)}</tr>')
        
    week_m = {m: {t.id: 0 for t in ORDERED_TARGETS} for m in ("views","likes","replies","reposts")}
    week_totals = {m: 0 for m in ("views","likes","replies","reposts")}
    for post in data["posts"]:
        for target in ORDERED_TARGETS:
            for m in ("views","likes","replies","reposts"):
                v = get_target_metric(post, target.id, m)
                week_m[m][target.id] += v
                week_totals[m] += v
    week_sigma = "".join(_mspan(week_totals[m], mm) for m, mm in (("views","mv"),("likes","ml"),("replies","mr"),("reposts","mp")))
    week_cols = ['<td colspan="4"><b>Итого за неделю</b></td>', '<td></td>', f'<td class="text-center font-bold">{week_sigma}</td>']
    for target in ORDERED_TARGETS:
        cell = "".join(_mspan(week_m[m][target.id], mm) for m, mm in (("views","mv"),("likes","ml"),("replies","mr"),("reposts","mp")))
        week_cols.append(f'<td class="text-center font-bold">{cell}</td>')
    week_cols.append('<td></td>')
    rendered_rows.append(f'<tr class="week-total">{"".join(week_cols)}</tr>')

    rows = "\n".join(rendered_rows) if rendered_rows else f"<tr><td colspan=\"{7 + len(ORDERED_TARGETS)}\">empty</td></tr>"
    return f"""
    <section style="margin-top: 0;">
      {pagination_bar}
      <div class="metric-dashboard">
        <div class="metric-toggle metric-toggle--vertical" id="metric-toggle">
          <button class="mt-btn mt-active" data-m="mv" onclick="setMetric('mv')">👁 Views</button>
          <button class="mt-btn" data-m="ml" onclick="setMetric('ml')">❤️ Likes</button>
          <button class="mt-btn" data-m="mr" onclick="setMetric('mr')">💬 Replies</button>
        </div>
        {_weekly_chart(data["posts"])}
      </div>
      <div class="table-wrap">
      <table id="pipeline-table" class="show-mv">
        <thead>
          <tr>
            <th colspan="6"></th>
            {target_row1}
            <th></th>
          </tr>
          <tr>
            <th>Post</th>
            <th class="date-col">Date</th>
            <th>RU</th>
            <th>EN</th>
            <th>Media</th>
            <th class="text-center" title="Общие просмотры">&Sigma;</th>
            {target_row2}
            <th class="text-center" title="Repair">{_TOOL_ICON}</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
      </div>
      <p class="note">
        Feed: {int(data['feed']['items'])} | 
        Processed: {int(data['social_worker']['processed_count'])} | 
        Last update: {_esc(data['social_worker']['last_update_id'] or 'n/a')} | 
        JSON: <a href="/api/pipeline-status?week_offset={week_offset}">/api/pipeline-status</a> | 
        Updated: {_esc(data['updated_at'])}
      </p>
    </section>
    """


def _repair_section(request: Request) -> str:
    ref = _esc(request.query_params.get("ref") or "")
    message_id = _esc(request.query_params.get("message_id") or "")
    options = "\n".join(f'<option value="{_esc(target.id)}">{_esc(target.label)}</option>' for target in ORDERED_TARGETS)
    return f"""
    <section>
      <h2>Repair</h2>
      <form method="post" action="/api/command-center/action">
        <input name="token" type="hidden" value="">
        <select name="action">
          <option value="retry">Retry / republish</option>
          <option value="edit_en">Edit EN</option>
          <option value="replace_en_media">Replace EN media</option>
          <option value="use_ru_media_for_en">Use RU media for EN</option>
        </select>
        <input name="ref" placeholder="post id / post:key / msg:id" value="{ref}">
        <input name="message_id" placeholder="telegram message id (edit/media only)" value="{message_id}">
        <select name="target">
          <option value="">all targets</option>
          {options}
        </select>
        <textarea name="text_en" placeholder="EN text for edit_en"></textarea>
        <textarea name="media_en_json" placeholder='EN media JSON, example: [{{"type":"photo","file_id":"..."}}]'></textarea>
        <button type="submit">Apply</button>
      </form>
    </section>
    """


def _queue_section(ops: dict) -> str:
    drafts = "\n".join(
        f"<tr><td>{int(row['id'])}</td><td>{_esc(row.get('status'))}</td><td class='wide'>{_esc(truncate_text(row.get('text_ru') or '', 90))}</td><td>{_esc(row.get('scheduled_at') or '')}</td><td>{_esc(row.get('scheduled_en_at') or '')}</td><td>{_esc(row.get('channel_message_id') or '')}</td><td>{_esc(row.get('updated_at'))}</td></tr>"
        for row in ops["drafts"]
    ) or "<tr><td colspan='7'>empty</td></tr>"
    queue = "\n".join(
        "<tr>"
        f"<td>{_esc(row.get('job_id'))}</td>"
        f"<td>{_esc(row.get('post_id') or '')}</td>"
        f"<td>{_esc(row.get('message_id') or '')}</td>"
        f"<td>{_esc(row.get('target'))}</td>"
        f"<td>{_esc(row.get('status'))}</td>"
        f"<td>{int(row.get('attempt_count') or 0)}</td>"
        f"<td>{_esc(row.get('publish_at') or '')}</td>"
        f"<td>{_esc(row.get('next_attempt_at') or '')}</td>"
        f"<td class='wide'>{_esc(row.get('last_error') or '')}</td>"
        f"<td>{_esc(row.get('updated_at') or row.get('created_at') or '')}</td>"
        "</tr>"
        for row in ops["queue"]
    ) or "<tr><td colspan='9'>empty</td></tr>"
    return f"""
    <section><h2>Drafts</h2><table><thead><tr><th>ID</th><th>Status</th><th>RU</th><th>RU slot</th><th>EN slot</th><th>Message</th><th>Updated</th></tr></thead><tbody>{drafts}</tbody></table></section>
    <section><h2>Queue</h2><table><thead><tr><th>Job</th><th>Post</th><th>Telegram msg</th><th>Target</th><th>Status</th><th>Attempts</th><th>Publish at</th><th>Retry at</th><th>Error</th><th>Updated</th></tr></thead><tbody>{queue}</tbody></table></section>
    """


def _credentials_section(ops: dict) -> str:
    rows = "\n".join(
        f"<tr><td>{_esc(row.get('target'))}</td><td>{_esc(row.get('status'))}</td><td>{_esc(row.get('missing_env_json'))}</td><td>{_esc(row.get('last_checked_at'))}</td></tr>"
        for row in ops["credentials"]
    ) or "<tr><td colspan='4'>empty</td></tr>"
    return f"<section><h2>Credentials</h2><table><thead><tr><th>Target</th><th>Status</th><th>Missing</th><th>Checked</th></tr></thead><tbody>{rows}</tbody></table></section>"


def _diagnostics_section(ops: dict) -> str:
    errors = "\n".join(
        f"<tr><td>{_esc(row.get('message_id'))}</td><td>{_esc(row.get('target'))}</td><td>{_esc(row.get('status'))}</td><td class='wide'>{_esc(row.get('error'))}</td></tr>"
        for row in ops["errors"][:30]
    ) or "<tr><td colspan='4'>empty</td></tr>"
    lifecycle = "\n".join(
        f"<tr><td>{_esc(row.get('message_id'))}</td><td>{_esc(row.get('state'))}</td><td>{_esc(row.get('reason'))}</td><td>{_esc(row.get('updated_at'))}</td></tr>"
        for row in ops["lifecycle"][:30]
    ) or "<tr><td colspan='4'>empty</td></tr>"
    return f"""
    <section><h2>Errors</h2><table><thead><tr><th>Message</th><th>Target</th><th>Status</th><th>Error</th></tr></thead><tbody>{errors}</tbody></table></section>
    <section><h2>Lifecycle</h2><table><thead><tr><th>Message</th><th>State</th><th>Reason</th><th>Updated</th></tr></thead><tbody>{lifecycle}</tbody></table></section>
    <section><h2>Advanced JSON</h2><p><a href="/api/ops-dashboard">/api/ops-dashboard</a> includes analytics, media assets, capabilities and content memory for agents.</p></section>
    """


def command_center_page(request: Request, forced_tab: str | None = None) -> str:
    tab = forced_tab or _active_tab(request)
    ops = command_center_payload()
    if tab == "repair":
        body = _repair_section(request)
    elif tab == "queue":
        body = _queue_section(ops)
    elif tab == "credentials":
        body = _credentials_section(ops)
    elif tab == "diagnostics":
        body = _diagnostics_section(ops)
    else:
        body = _pipeline_section(request)
    return f"""<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Command Center</title>
  <style>
    body {{ margin:0; padding:24px; background:#0d1117; color:#c9d1d9; font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }}
    main {{ max-width:1480px; margin:0 auto; }}
    h1,h2 {{ color:#fff; }}
    nav {{ display:flex; gap:8px; flex-wrap:wrap; margin:18px 0 0; padding-top:12px; border-top:1px solid #30363d; }}
    nav a {{ color:#c9d1d9; border:1px solid #30363d; padding:6px 9px; border-radius:6px; text-decoration:none; font-size:13px; }}
    nav a.active {{ color:#fff; border-color:#58a6ff; background:#13233a; }}
    .grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:12px 0 18px; }}
    .stat, section {{ border:1px solid #30363d; background:#161b22; border-radius:8px; }}
    .stat {{ padding:14px; }} .stat span {{ display:block; color:#58a6ff; font-size:24px; font-weight:700; margin-top:6px; }}
    section {{ margin-top:0; padding:10px; overflow-x:auto; }}
    .table-wrap {{ overflow-x:auto; }}
    table {{ width:100%; min-width:980px; border-collapse:collapse; }}
    th,td {{ padding:6px 10px; border-bottom:1px solid #30363d; text-align:left; vertical-align:top; }}
    th {{ color:#8b949e; white-space:nowrap; }}
    a {{ color:#58a6ff; }} .wide {{ max-width:520px; overflow-wrap:anywhere; }}
    .post-text {{ max-width:280px; overflow-wrap:anywhere; }}
    .nowrap {{ white-space:nowrap; }} .note {{ color:#8b949e; }}
    .date-col {{ width:60px; }}
    .text-center {{ text-align:center; }}

    th svg {{ color:#8b949e; transition:color 0.2s; }}
    th:hover svg {{ color:#fff; }}
    form {{ display:flex; flex-wrap:wrap; gap:8px; }}
    input,select,textarea,button {{ background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:6px; padding:8px; }}
    textarea {{ min-width:min(720px,100%); min-height:70px; }}
    
    .day-header td {{ background: #21262d; color: #fff; font-weight: 600; padding: 8px 12px; border-bottom: 1px solid #30363d; }}
    .week-total td {{ background: #1a3a5c; color: #7dd3fc; font-weight: 700; padding: 10px 12px; border-top: 2px solid #3b82f6; border-bottom: 2px solid #3b82f6; }}
    .day-separator td {{ padding: 4px 12px 2px; background: transparent; border-top: 1px solid #30363d; border-bottom: 0; }}
    .day-label {{ font-size: 11px; font-weight: 700; color: #8b949e; text-transform: uppercase; letter-spacing: 0.06em; }}
    /* metric spans — show only active metric */
    .mv,.ml,.mr,.mp {{ display:none; }}
    #pipeline-table.show-mv .mv {{ display:inline; }}
    #pipeline-table.show-ml .ml {{ display:inline; }}
    #pipeline-table.show-mr .mr {{ display:inline; }}
    #pipeline-table.show-mp .mp {{ display:inline; }}
    /* metric toggle pill */
    .metric-dashboard {{ display:grid; grid-template-columns:112px minmax(0,1fr); gap:8px; align-items:stretch; margin:0 0 8px; }}
    .metric-toggle {{ display:flex; gap:6px; margin:0; }}
    .metric-toggle--vertical {{ flex-direction:column; justify-content:center; }}
    .mt-btn {{ background:#161b22; color:#8b949e; border:1px solid #30363d; border-radius:18px; padding:5px 10px; font-size:13px; cursor:pointer; transition:all 0.15s; text-align:left; }}
    .mt-btn:hover {{ background:#21262d; color:#c9d1d9; }}
    .mt-btn.mt-active {{ background:#1f6feb; color:#fff; border-color:#1f6feb; font-weight:600; }}
    .day-stat td {{ border-top: 1px solid #30363d; border-bottom: 2px double #30363d; background: #161b22; color: #c9d1d9; }}
    .day-stat-label {{ text-align: right; color: #8b949e; font-weight: normal; }}
    .font-bold {{ font-weight: bold; }}
    .pagination-bar {{ display: flex; align-items: center; justify-content: center; gap: 10px; margin: 0 0 8px; padding: 5px 8px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }}
    .pag-btn {{ color: #58a6ff; border: 1px solid #30363d; padding: 4px 9px; border-radius: 6px; text-decoration: none; font-size: 12px; background: #0d1117; transition: background 0.2s, border-color 0.2s; }}
    .pag-btn:hover:not(.disabled) {{ background: #21262d; border-color: #8b949e; }}
    .pag-btn.disabled {{ color: #8b949e; border-color: #21262d; background: #0d1117; cursor: not-allowed; }}
    .pag-current {{ font-weight: 700; color: #fff; font-size: 14px; }}
    .metric-chart {{ position:relative; margin:0; padding:7px 10px 4px; background:#0d1117; border:1px solid #30363d; border-radius:8px; }}
    .metric-chart svg {{ width:100%; height:166px; display:block; }}
    .metric-chart text {{ fill:#8b949e; font-size:11px; }}
    .chart-grid {{ stroke:#30363d; stroke-width:1; opacity:.75; }}
    .chart-line {{ vector-effect: non-scaling-stroke; }}
    .metric-chart__legend {{ display:flex; flex-wrap:wrap; gap:11px; margin:0 0 -1px; color:#c9d1d9; font-size:12px; }}
    .metric-chart__legend span {{ display:inline-flex; align-items:center; gap:5px; }}
    .metric-chart__legend i {{ display:inline-block; width:9px; height:9px; border-radius:50%; }}
    .metric-chart__hint {{ color:#8b949e; font-size:11px; margin:0 0 2px; }}
    .chart-point {{ vector-effect: non-scaling-stroke; stroke:#0d1117; stroke-width:1.4; }}
    .chart-hit {{ fill:transparent; cursor:crosshair; }}
    .chart-tooltip {{ position:fixed; z-index:50; pointer-events:none; max-width:280px; padding:7px 9px; background:#161b22; border:1px solid #58a6ff; border-radius:6px; color:#f0f6fc; font-size:12px; box-shadow:0 8px 24px rgba(0,0,0,.35); white-space:nowrap; }}
    @media (max-width: 760px) {{
      .metric-dashboard {{ grid-template-columns:1fr; }}
      .metric-toggle--vertical {{ flex-direction:row; justify-content:flex-start; }}
    }}
  </style>
</head>
<body>
<main>
  {body}
  <p class="note">Updated: {_esc(ops['updated_at'])}</p>
  <nav>{_nav(tab)}</nav>
</main>
<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  document.querySelectorAll('input[name="token"]').forEach((input) => input.value = token);
  function setMetric(m) {{
    const tbl = document.getElementById('pipeline-table');
    tbl.className = tbl.className.replace(/show-m\w/g, '') + ' show-' + m;
    document.querySelectorAll('.mt-btn').forEach(b => b.classList.toggle('mt-active', b.dataset.m === m));
  }}
  const chartTooltip = document.getElementById('chart-tooltip');
  document.querySelectorAll('.chart-hit').forEach((point) => {{
    point.addEventListener('mouseenter', () => {{
      if (!chartTooltip) return;
      chartTooltip.textContent = point.dataset.tooltip || '';
      chartTooltip.hidden = false;
    }});
    point.addEventListener('mousemove', (event) => {{
      if (!chartTooltip) return;
      chartTooltip.style.left = `${{event.clientX + 12}}px`;
      chartTooltip.style.top = `${{event.clientY + 12}}px`;
    }});
    point.addEventListener('mouseleave', () => {{
      if (chartTooltip) chartTooltip.hidden = true;
    }});
  }});
</script>
</body>
</html>"""
