import json


class FakeResponse:
    status = 200
    headers = {}
    body = json.dumps({"url": "https://dev.to/alexgetmancom/post"}).encode()


def test_publish_to_devto_sends_main_image(monkeypatch):
    captured = {}

    def fake_request(url, *, data=None, headers=None, method="GET", timeout=30, **_kwargs):
        captured["url"] = url
        captured["body"] = json.loads(data.decode())
        captured["headers"] = headers
        captured["method"] = method
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("posting_core.clients.devto.DEVTO_API_KEY", "token")
    monkeypatch.setattr("posting_core.http_client.request", fake_request)

    from posting_core.clients.devto import publish_to_devto

    url = publish_to_devto(
        title="Title",
        body_markdown="Body",
        canonical_url="https://alexgetman.com/20/post/",
        tags=["AI Models"],
        main_image="https://alexgetman.com/media/20.jpg",
    )

    assert url == "https://dev.to/alexgetmancom/post"
    assert captured["body"]["article"]["main_image"] == "https://alexgetman.com/media/20.jpg"
    assert captured["body"]["article"]["canonical_url"] == "https://alexgetman.com/20/post/"
    assert captured["body"]["article"]["tags"] == ["aimodels"]


def test_first_public_image_url_uses_first_image():
    from posting_core.clients.meta import _first_public_image_url

    assert (
        _first_public_image_url(
            [
                {"type": "VIDEO", "vps_url": "https://alexgetman.com/video.mp4"},
                {"type": "IMAGE", "vps_url": "https://alexgetman.com/image.jpg"},
                {"type": "IMAGE", "vps_url": "https://alexgetman.com/second.jpg"},
            ]
        )
        == "https://alexgetman.com/image.jpg"
    )
