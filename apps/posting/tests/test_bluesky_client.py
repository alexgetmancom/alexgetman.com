import json

from posting_core.clients import bluesky


def test_bluesky_public_url_from_at_uri(monkeypatch):
    monkeypatch.setattr(bluesky, "BLUESKY_HANDLE", "alexgetmancom.bsky.social")

    assert bluesky.bluesky_public_url("at://did:plc:x/app.bsky.feed.post/abc") == (
        "https://bsky.app/profile/alexgetmancom.bsky.social/post/abc"
    )


def test_verify_bluesky_root_visible_uses_author_feed(monkeypatch):
    monkeypatch.setattr(bluesky, "BLUESKY_HANDLE", "alexgetmancom.bsky.social")

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def read(self):
            return json.dumps(
                {
                    "feed": [
                        {"post": {"uri": "at://did:plc:x/app.bsky.feed.post/abc"}},
                    ]
                }
            ).encode()

    monkeypatch.setattr(bluesky.urllib.request, "urlopen", lambda *args, **kwargs: FakeResponse())

    assert bluesky.verify_bluesky_root_visible("at://did:plc:x/app.bsky.feed.post/abc") == (
        True,
        "visible_in_author_feed",
    )
