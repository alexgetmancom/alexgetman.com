from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse

from site_feed.auth import command_allowed
from site_feed.config import PIPELINE_DB
from site_feed.command_actions import parse_action_request, run_command_action
from site_feed.command_center_ui import command_center_page
from site_feed.ops_dashboard import command_center_payload
from site_feed.pipeline import pipeline_status_payload
from posting_core.db import connect
from posting_core.ops_lookup import resolve_publication_ref


def register_dashboard_routes(app: FastAPI) -> None:
    @app.get("/api/pipeline-status")
    async def pipeline_status_json(request: Request):
        try:
            week_offset = int(request.query_params.get("week_offset") or 0)
        except ValueError:
            week_offset = 0
        return pipeline_status_payload(week_offset=week_offset)

    @app.get("/api/command-center")
    async def command_center_json(request: Request):
        if not command_allowed(request):
            raise HTTPException(status_code=403, detail="forbidden")
        return command_center_payload()

    @app.get("/api/post-debug")
    async def post_debug_json(request: Request, ref: str | None = None):
        if not command_allowed(request):
            raise HTTPException(status_code=403, detail="forbidden")
        if not ref:
            raise HTTPException(status_code=400, detail="missing ref")
        if not PIPELINE_DB.exists():
            raise HTTPException(status_code=404, detail="pipeline db not found")
        with connect(PIPELINE_DB) as conn:
            resolved = resolve_publication_ref(conn, ref)
            post = conn.execute("SELECT * FROM posts WHERE post_key=?", (resolved.post_key,)).fetchone()
            targets = conn.execute("SELECT * FROM post_targets WHERE post_key=? ORDER BY target", (resolved.post_key,)).fetchall()
            metrics = conn.execute("SELECT * FROM post_metrics WHERE post_key=? ORDER BY target, metric_name", (resolved.post_key,)).fetchall()
            schedule = conn.execute("SELECT * FROM metric_schedule WHERE post_key=? ORDER BY target", (resolved.post_key,)).fetchall()
        return {
            "ref": resolved.__dict__,
            "post": dict(post) if post else None,
            "targets": [dict(row) for row in targets],
            "metrics": [dict(row) for row in metrics],
            "schedule": [dict(row) for row in schedule],
        }

    @app.get("/api/ops-dashboard")
    async def ops_dashboard_json(request: Request):
        if not command_allowed(request):
            raise HTTPException(status_code=403, detail="forbidden")
        return {"pipeline": pipeline_status_payload(), "ops": command_center_payload()}

    @app.get("/pipeline-status", response_class=HTMLResponse)
    async def pipeline_status_page(request: Request):
        return command_center_page(request, forced_tab="pipeline")

    @app.get("/command-center", response_class=HTMLResponse)
    async def command_center(request: Request):
        if not command_allowed(request):
            return PlainTextResponse("forbidden\n", status_code=403)
        return command_center_page(request)

    @app.post("/api/command-center/action")
    async def command_center_action(request: Request):
        action = await parse_action_request(request)
        if not command_allowed(request, action.token):
            raise HTTPException(status_code=403, detail="forbidden")
        try:
            return run_command_action(action)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
