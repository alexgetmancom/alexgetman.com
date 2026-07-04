from __future__ import annotations

import json
import urllib.request
import urllib.error

from posting_core.publish_config import (
    GITHUB_DISCUSSIONS_TOKEN,
    GITHUB_DISCUSSIONS_REPO_ID,
    GITHUB_DISCUSSIONS_CATEGORY_ID,
    log,
)


def publish_to_github_discussion(title: str, body_markdown: str) -> str | None:
    """
    Publish a post to GitHub Discussions via GraphQL API.
    Returns the discussion URL on success, None on failure.
    """
    if not GITHUB_DISCUSSIONS_TOKEN:
        log("GitHub Discussions token is missing, skipping")
        return None

    # Retrieve parameters or use defaults
    repo_id = GITHUB_DISCUSSIONS_REPO_ID or "R_kgDOSJwPnQ"
    category_id = GITHUB_DISCUSSIONS_CATEGORY_ID or "DIC_kwDOSJwPnc4C-S2f"

    # GraphQL mutation query to create a discussion
    query = """
    mutation($repoId: ID!, $catId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {
        repositoryId: $repoId,
        categoryId: $catId,
        title: $title,
        body: $body
      }) {
        discussion {
          id
          url
        }
      }
    }
    """

    variables = {
        "repoId": repo_id,
        "catId": category_id,
        "title": title,
        "body": body_markdown,
    }

    payload = json.dumps({
        "query": query,
        "variables": variables
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            "https://api.github.com/graphql",
            data=payload,
            headers={
                "Authorization": f"Bearer {GITHUB_DISCUSSIONS_TOKEN}",
                "Content-Type": "application/json",
                "User-Agent": "alexgetman-posting",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))
            
            # GraphQL error checking
            if "errors" in resp_data:
                errs = resp_data["errors"]
                log(f"GitHub GraphQL error: {json.dumps(errs)}")
                return None
                
            discussion = resp_data.get("data", {}).get("createDiscussion", {}).get("discussion", {})
            url = discussion.get("url")
            log(f"GitHub Discussion published: {url}")
            return url

    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        log(f"GitHub Discussions publish failed: {exc.code} {body}")
        return None
    except Exception as exc:
        log(f"GitHub Discussions publish error: {exc}")
        return None
