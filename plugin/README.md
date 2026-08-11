# The `studio` plugin

Operate a deployment from a machine that has no checkout of this repository. The MCP transport at
`/api/mcp` is the entire interface — no database access, no SSH, no source tree on that machine.
The plugin packages that transport together with the skill that drives it, so one install gives an
agent the whole Studio: writing, publishing, scheduling, analytics and delivery diagnostics.

Nothing about any particular deployment is baked in. You supply your own endpoint and token.

## Setting it up

Don't do it by hand. Open [setup-prompt.md](setup-prompt.md), copy the whole file, and paste it
into your agent. It asks you for the few things it cannot discover — your domain, how you reach the
server, your Telegram user id — then exposes the routes, generates the credential, restarts the
deployment, installs the plugin here and proves the connection works before reporting back.

It is written to refuse the dangerous shortcuts: it backs up before editing, never prints your
token, and never publishes anything to test itself.

## Teaching it your voice

The skill already tells the agent *how to behave* — when to publish, when to stop at a draft, which
tool to reach for. What it cannot know is what your channel sounds like. Put that on the operating
machine, in that agent's own `AGENTS.md` or `CLAUDE.md`:

```markdown
# My channel

I publish <topic> to <audience>. Posts are <language>, <length>, and open with the news itself
rather than a greeting. <Any formatting habit: emoji lead, no hashtags, links at the end.>

When I say "post this", publish it. When I say "let's prepare" or "draft", stop at the draft and
show me the preview — I approve from the Telegram bot. Never publish a second time because a call
looked like it failed; check first.

Before writing, read the last few posts so the new one does not repeat one of them.
```

Then talk to it normally:

- "Post this: `<news>`" — writes, validates, publishes.
- "Let's prepare a post about `<topic>` for tomorrow morning" — drafts and schedules.
- "Why didn't yesterday's post reach X?" — reads the delivery state and names the missing target.
- "How did last week's posts do?" — reads analytics.

## When something does not work

| Symptom | Cause |
| :--- | :--- |
| `401` from `/api/mcp` | The token does not match, or the deployment has no `MCP_STUDIO_TOKEN` set |
| `404` from `/api/mcp` | The proxy never routed it — the allowlist does not name the path |
| Tools connect, but the workspace looks empty | `MCP_STUDIO_ACTOR_ID` points at an actor with no work |
| A post publishes without its media | The file was never uploaded, or `/api/studio/media` is not exposed |

Ask the agent to run `ops_guide`, then `ops_audit`, before digging further.
