import importlib.util
import sys
import types
from pathlib import Path


class FakeFastAPI:
    def __init__(self, *args, **kwargs):
        self.routes = []
        self.kwargs = kwargs

    def get(self, path, **kwargs):
        return self._route("GET", path, kwargs)

    def post(self, path, **kwargs):
        return self._route("POST", path, kwargs)

    def _route(self, method, path, kwargs):
        def decorator(func):
            self.routes.append({"method": method, "path": path, "kwargs": kwargs, "handler": func})
            return func

        return decorator


class FakeHTTPException(Exception):
    def __init__(self, status_code, detail=None):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def test_fastapi_app_registers_production_routes_without_collector(monkeypatch):
    module_path = Path(__file__).resolve().parents[1] / "site_feed" / "app.py"
    fake_fastapi = types.ModuleType("fastapi")
    fake_fastapi.FastAPI = FakeFastAPI
    fake_fastapi.HTTPException = FakeHTTPException
    fake_fastapi.Request = object
    fake_fastapi.Response = object
    fake_responses = types.ModuleType("fastapi.responses")
    fake_responses.HTMLResponse = object
    fake_responses.JSONResponse = object
    fake_responses.PlainTextResponse = object
    fake_responses.StreamingResponse = object
    fake_responses.FileResponse = object
    fake_uvicorn = types.ModuleType("uvicorn")
    fake_uvicorn.run = lambda *args, **kwargs: None
    fake_pydantic = types.ModuleType("pydantic")

    class FakeBaseModel:
        def __init__(self, **kwargs):
            for key, value in kwargs.items():
                setattr(self, key, value)

    fake_pydantic.BaseModel = FakeBaseModel
    monkeypatch.setitem(sys.modules, "fastapi", fake_fastapi)
    monkeypatch.setitem(sys.modules, "fastapi.responses", fake_responses)
    monkeypatch.setitem(sys.modules, "pydantic", fake_pydantic)
    monkeypatch.setitem(sys.modules, "uvicorn", fake_uvicorn)
    monkeypatch.setenv("WEBHOOK_PATH", "/tg-feed/webhook")
    sys.modules.pop("collector", None)

    spec = importlib.util.spec_from_file_location("site_feed_fastapi_app_test", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    routes = {(route["method"], route["path"]) for route in module.app.routes}
    assert routes == {
        ("GET", "/tg-feed/healthz"),
        ("GET", "/healthz"),
        ("GET", "/readyz"),
        ("GET", "/api/pipeline-status"),
        ("GET", "/api/command-center"),
        ("GET", "/api/post-debug"),
        ("GET", "/api/ops-dashboard"),
        ("GET", "/pipeline-status"),
        ("GET", "/command-center"),
        ("POST", "/api/command-center/action"),
        ("GET", "/stats"),
        ("POST", "/stats/pageview"),
        ("GET", "/api/likes"),
        ("GET", "/api/likes/batch"),
        ("POST", "/api/likes"),
        ("POST", "/tg-feed/webhook"),
        ("GET", "/api/mcp"),
        ("POST", "/api/mcp"),
        ("GET", "/{path:path}.md"),
    }
    assert "collector" not in sys.modules
