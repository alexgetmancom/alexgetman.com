import json


class FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps({"url": "https://dev.to/alexgetmancom/post"}).encode()


def test_publish_to_devto_sends_main_image(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data.decode())
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("posting_core.clients.devto.DEVTO_API_KEY", "token")
    monkeypatch.setattr("posting_core.clients.devto.urllib.request.urlopen", fake_urlopen)

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
