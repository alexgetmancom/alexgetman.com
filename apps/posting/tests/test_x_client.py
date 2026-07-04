import sys
import types
from unittest.mock import Mock

from posting_core.clients import x


def test_video_upload_uses_amplify_video_category(tmp_path, monkeypatch):
    video = tmp_path / "video.mp4"
    video.write_bytes(b"video")
    response = Mock(status_code=201)
    response.json.return_value = {"data": {"id": "tweet-1"}}
    fake_requests = types.SimpleNamespace(post=Mock(return_value=response))
    fake_oauth = types.SimpleNamespace(OAuth1=Mock(return_value="auth"))
    upload = Mock(return_value="media-1")

    monkeypatch.setattr(x, "X_CONSUMER_KEY", "key")
    monkeypatch.setattr(x, "X_CONSUMER_SECRET", "secret")
    monkeypatch.setattr(x, "X_ACCESS_TOKEN", "token")
    monkeypatch.setattr(x, "X_ACCESS_TOKEN_SECRET", "token-secret")
    monkeypatch.setattr(x, "upload_x_media_chunked", upload)
    monkeypatch.setitem(sys.modules, "requests", fake_requests)
    monkeypatch.setitem(sys.modules, "requests_oauthlib", fake_oauth)

    tweet_id = x.publish_to_x("hello https://example.com", [{"type": "VIDEO", "local_path": str(video)}])

    assert tweet_id == "tweet-1"
    upload.assert_called_once()
    _, _, kwargs = upload.mock_calls[0]
    assert kwargs["media_type"] == "video/mp4"
    assert kwargs["media_category"] == "amplify_video"
    fake_requests.post.assert_called_once()
    assert fake_requests.post.call_args.kwargs["json"] == {
        "text": "hello",
        "media": {"media_ids": ["media-1"]},
    }
