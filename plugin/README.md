# The `studio` plugin

Operate a deployment from a machine that has no checkout of this repository. The MCP transport at
`/api/mcp` is the entire interface — there is no database access, no SSH, and no source tree on that
machine. The plugin packages that transport together with the skill that drives it, so one install
gives an agent the whole Studio: writing, publishing, scheduling, analytics and delivery
diagnostics.

Nothing about any particular deployment is baked in. You supply your own endpoint and token.

## Before you install

The deployment has to be reachable and has to know the credential.

1. **Expose two routes.** `/api/mcp` is the transport; `/api/studio/media` receives uploads, because
   a post with a picture or a video sends the file separately from the command. Both refuse a
   request without the bearer token, so they are safe to expose — but a reverse proxy that
   allowlists paths will 404 them until you name them. See
   [deploy/nginx/production/marux.ru.conf](../deploy/nginx/production/marux.ru.conf) for a worked
   example of an allowlist that ends in `return 404`.

2. **Set the credential.** In the deployment's `secrets.env`:

   ```dotenv
   MCP_STUDIO_TOKEN=<32 random bytes, hex>
   MCP_STUDIO_ACTOR_ID=<the Telegram user id the work belongs to>
   ```

   Generate the token with `openssl rand -hex 32`. Both must be set together — the application
   refuses to start with one of them. The actor id must appear in `STUDIO_ACTOR_IDS`, or in
   `CONTROLLER_ADMIN_IDS` when that is the roster; an actor in the roster sees the whole roster's
   work, so several people share one Studio while new work is attributed to whoever created it.

3. **Recreate the container** and confirm:

   ```bash
   bun run --filter @alexgetman/backend ops doctor
   ```

   `checks.studioTransportConfigured` must be `true`.

## Install

On the operator's machine:

```shell
/plugin marketplace add alexgetmancom/alexgetman.com
/plugin install studio@alexgetman
```

Enabling it asks for the two values. The token is marked sensitive, so it goes to secure storage
rather than `settings.json`, and is substituted into the `Authorization` header at connection time.

One install points at one deployment. A second Studio is a second machine, or a second install
scope — not a second entry in the marketplace.

Confirm the connection with `/mcp`: the `studio` server should be listed, and asking the agent
"what can this Studio do?" should produce a real answer from `studio_capabilities` rather than a
guess.

## The prompt to start with

The skill already tells the agent how to behave — when to publish, when to stop at a draft, which
tool to reach for. It does not know anything about *your* editorial voice, and that is what is
worth writing down. Paste something like this into the agent's own `AGENTS.md` or `CLAUDE.md` on
that machine, edited to fit:

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

- "Post this: <news>" — writes, validates, publishes.
- "Let's prepare a post about <topic> for tomorrow morning" — drafts and schedules.
- "Why didn't yesterday's post reach X?" — reads the delivery state and reports the missing target.
- "How did last week's posts do?" — reads analytics.

## When something does not work

| Symptom | Cause |
| :--- | :--- |
| `401` from `/api/mcp` | The token does not match, or the deployment has no `MCP_STUDIO_TOKEN` set |
| `404` from `/api/mcp` | The proxy never routed it — the allowlist does not name the path |
| Tools connect, but the workspace looks empty | `MCP_STUDIO_ACTOR_ID` points at an actor with no work; check it is the right id |
| A post publishes without its media | The file was never uploaded, or `/api/studio/media` is not exposed |

Start any deeper investigation by asking the agent to run `ops_guide`, then `ops_audit`.
