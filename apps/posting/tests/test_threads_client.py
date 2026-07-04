from posting_core.clients import threads


def test_threads_reply_missing_media_after_root_is_partial_success(monkeypatch):
    calls = []

    def fake_call_threads(endpoint, payload, method="POST", token=None):
        calls.append((endpoint, payload, method, token))
        if endpoint == "me/threads" and payload.get("media_type") == "IMAGE":
            return {"id": "root-container"}
        if endpoint == "me/threads_publish" and payload.get("creation_id") == "root-container":
            return {"id": "root-post"}
        if endpoint == "me/threads" and payload.get("reply_to_id") == "root-post":
            return {"id": "reply-container"}
        if endpoint == "me/threads_publish" and payload.get("creation_id") == "reply-container":
            raise Exception(
                'Threads API HTTP 400: {"error":{"code":24,"error_subcode":4279009,'
                '"message":"The requested resource does not exist"}}'
            )
        if endpoint == "root-post" and method == "GET":
            return {"permalink": "https://www.threads.net/@alexgetmanco/post/root"}
        raise AssertionError((endpoint, payload, method, token))

    monkeypatch.setattr(threads, "ENABLE_THREADS", True)
    monkeypatch.setattr(threads, "call_threads", fake_call_threads)
    monkeypatch.setattr(threads, "wait_for_container", lambda *args, **kwargs: True)
    monkeypatch.setattr(threads.time, "sleep", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(threads, "split_text", lambda *_args, **_kwargs: ["root text", "reply text"])

    result = threads.publish_to_threads_target(
        "root text\n\nreply text",
        [{"type": "IMAGE", "vps_url": "https://example.com/image.jpg"}],
        {},
        "token",
        "threads_en",
    )

    assert result["ok"] is True
    assert result["partial"] is True
    assert result["id"] == "root-post"
    assert result["ids"] == ["root-post"]
    assert result["url"] == "https://www.threads.com/@alexgetmanco/post/root"

    reply_publish_calls = [
        call for call in calls if call[0] == "me/threads_publish" and call[1].get("creation_id") == "reply-container"
    ]
    assert len(reply_publish_calls) == 3
