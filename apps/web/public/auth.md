# auth.md

## Service

AlexGetman exposes public, read-only content for agents. No registration or OAuth token is required for these resources.

## Discovery

- Resource metadata: `https://alexgetman.com/.well-known/oauth-protected-resource`
- API catalog: `https://alexgetman.com/.well-known/api-catalog`
- MCP server card: `https://alexgetman.com/.well-known/mcp/server-card.json`
- Agent skills: `https://alexgetman.com/.well-known/agent-skills/index.json`

## Public resources

- English feed: `https://alexgetman.com/feed.json`
- Russian feed: `https://alexgetman.com/ru/feed.json`
- Content index: `https://alexgetman.com/content-index.json`
- Content memory: `https://alexgetman.com/content-memory.md`
- MCP endpoint: `https://alexgetman.com/api/mcp`

The service does not currently issue access tokens and does not advertise identity, claim, revocation, or authorization endpoints. Administrative APIs remain private behind server authentication.
