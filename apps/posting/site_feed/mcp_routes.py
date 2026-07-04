import uuid
import sqlite3
import asyncio
import time
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from site_feed.config import PIPELINE_DB, log, now_iso

MAX_FEEDBACK_NAME_CHARS = 120
MAX_FEEDBACK_MESSAGE_CHARS = 2000
FEEDBACK_RATE_LIMIT_WINDOW_SECONDS = 3600
FEEDBACK_RATE_LIMIT_MAX = 5
_feedback_hits: dict[str, list[float]] = {}


def _jsonrpc_error(msg_id, code: int, message: str) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": code, "message": message},
    }


def _client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    client = request.client
    return client.host if client else "unknown"


def _rate_limited(key: str) -> bool:
    now = time.time()
    cutoff = now - FEEDBACK_RATE_LIMIT_WINDOW_SECONDS
    hits = [ts for ts in _feedback_hits.get(key, []) if ts >= cutoff]
    if len(hits) >= FEEDBACK_RATE_LIMIT_MAX:
        _feedback_hits[key] = hits
        return True
    hits.append(now)
    _feedback_hits[key] = hits
    return False


def register_mcp_routes(app: FastAPI) -> None:
    @app.get("/api/mcp")
    async def mcp_get(request: Request):
        # WebMCP / SSE transport handshake
        async def event_generator():
            # First event sends the POST endpoint relative to host
            yield f"event: endpoint\ndata: /api/mcp?connection_id={uuid.uuid4()}\n\n"
            # Keep connection open for the client
            while True:
                await asyncio.sleep(3600)

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )

    @app.post("/api/mcp")
    async def mcp_post(request: Request):
        try:
            body = await request.json()
        except Exception:
            return _jsonrpc_error(None, -32700, "Invalid JSON")
        if not isinstance(body, dict):
            return _jsonrpc_error(None, -32600, "Invalid request")
        method = body.get("method")
        msg_id = body.get("id")

        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "alexgetman-blog-mcp",
                        "version": "1.0.0"
                    }
                }
            }

        elif method == "tools/list":
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "tools": [
                        {
                            "name": "submit_feedback",
                            "description": "Send a feedback message, greeting, or report a bug directly to the blog owner (Alex Getman). Use this to leave a trace on the server!",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "name": {
                                        "type": "string",
                                        "description": "Your name, model identifier, or agent platform (e.g., Claude-3.5-Sonnet)"
                                    },
                                    "message": {
                                        "type": "string",
                                        "description": "The text of your feedback or greeting."
                                    }
                                },
                                "required": ["message"]
                            }
                        }
                    ]
                }
            }

        elif method == "tools/call":
            params = body.get("params", {})
            tool_name = params.get("name")
            if tool_name != "submit_feedback":
                return {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {
                        "code": -32601,
                        "message": f"Method not found: {tool_name}"
                    }
                }
            arguments = params.get("arguments", {})
            if not isinstance(arguments, dict):
                return _jsonrpc_error(msg_id, -32602, "Invalid arguments")

            agent_name = str(arguments.get("name") or "Anonymous Agent").strip()
            message = str(arguments.get("message") or "").strip()
            if not message:
                return _jsonrpc_error(msg_id, -32602, "message is required")
            if len(agent_name) > MAX_FEEDBACK_NAME_CHARS:
                return _jsonrpc_error(msg_id, -32602, f"name is too long; max {MAX_FEEDBACK_NAME_CHARS} characters")
            if len(message) > MAX_FEEDBACK_MESSAGE_CHARS:
                return _jsonrpc_error(msg_id, -32602, f"message is too long; max {MAX_FEEDBACK_MESSAGE_CHARS} characters")
            if _rate_limited(_client_key(request)):
                return _jsonrpc_error(msg_id, -32000, "rate limit exceeded")

            # Log to sqlite pipeline.db
            try:
                conn = sqlite3.connect(str(PIPELINE_DB), timeout=2)
                with conn:
                    conn.execute(
                        """
                        INSERT INTO post_events (post_key, target, event_type, severity, message, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            "mcp:feedback",
                            "mcp",
                            "mcp.feedback.received",
                            "info",
                            f"MCP Feedback from {agent_name}: {message}",
                            now_iso()
                        )
                    )
                log(f"MCP Feedback logged from {agent_name}: {message}")
            except Exception as e:
                log(f"Error logging MCP feedback: {e}")

            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": f"Thank you, {agent_name}! Your feedback has been successfully logged on the server. Alex Getman will see your trace."
                        }
                    ]
                }
            }

        # Safe fallback
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {}
        }
