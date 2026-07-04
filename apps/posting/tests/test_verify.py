from posting_core import verify


def test_verify_unpublished_target_is_not_ok():
    result = verify.verify_target_record({"target": "x", "status": "failed", "error": "boom"})

    assert result["ok"] is False
    assert result["target"] == "x"
    assert result["reason"] == "boom"


def test_verify_bluesky_uses_public_visibility(monkeypatch):
    monkeypatch.setattr(verify, "verify_bluesky_root_visible", lambda uri: (True, "visible_in_author_feed"))

    result = verify.verify_target_record(
        {
            "target": "bluesky",
            "status": "published",
            "external_id": "at://did:plc:x/app.bsky.feed.post/abc",
        }
    )

    assert result["ok"] is True
    assert result["url"] == "https://bsky.app/profile/alexgetmancom.bsky.social/post/abc"
    assert result["reason"] == "visible_in_author_feed"


def test_verify_target_without_known_public_url_is_best_effort():
    result = verify.verify_target_record({"target": "github_en", "status": "published"})

    assert result["ok"] is True
    assert result["reason"] == "no_public_url_known"
