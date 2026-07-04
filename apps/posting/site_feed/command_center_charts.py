from __future__ import annotations

import html
from zoneinfo import ZoneInfo

from site_feed.config import parse_date
from site_feed.pipeline import format_metric_value, get_target_metric


def _esc(value) -> str:
    return html.escape(str(value if value is not None else ""))


def weekly_chart(posts, ordered_targets) -> str:
    metrics = ("views", "likes", "replies")
    colors = {"views": "#58a6ff", "likes": "#f778ba", "replies": "#a5d6ff"}
    labels = {"views": "views", "likes": "likes", "replies": "replies"}
    days = {}
    for post in posts:
        day = parse_date(post["date"]).astimezone(ZoneInfo("Europe/Moscow")).date().isoformat()
        bucket = days.setdefault(day, {metric: 0 for metric in metrics})
        for target in ordered_targets:
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
