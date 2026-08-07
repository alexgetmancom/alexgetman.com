# How to work here

I am the only developer, reviewer, and operator of this system. No other code calls these APIs,
there is no team, there is no on-call rotation. Anything that exists to coordinate a team, or to
keep someone else's callers working, is dead weight. Assume the direct version of the work and do
not ask permission for it.

- No transitional scaffolding: no shims, no aliases kept "for one release", no facade or adapter
  layers bridging an old shape to a new one, no dual read/write windows, no flags guarding an old
  path, no backfills for a shape being abandoned. Cut over in one move — rename, delete the old
  path in the same commit, update every call site, migrate or drop the data.
- A wrapper is still a wrapper when it is small. A one-function file around another function, or a
  "facade" that is a type switch with casts inside, gets deleted.
- Build for the case that exists. No extension points, strategy layers, or config knobs with one
  implementation and no second one in sight.
- A shared abstraction that needs a branch on which caller it serves is the wrong abstraction. Push
  the difference into an explicit capability, or keep the two implementations apart under names that
  say what they do. Never add the branch.
- Deleting beats adding. Say how many lines went.
- One concept, one name. Two names for the same thing is a defect.
- Finish in one move: no TODO breadcrumbs, no stubs "for later", no half-migrated state in the tree.
  If it cannot be finished, say so instead of leaving a seam.
- Fewer, larger steps. A stage boundary belongs only where a real risk boundary is.
- No team ceremony: no RFCs, no ADRs, no deprecation notices, no changelog, no pull requests.
- One path to production. A second mechanism doing the same job means one of them is wrong.
- Tests where they earn their keep: silent breakage, wiring that drifts, bugs actually found. Not
  coverage as ritual.
- Verify, don't reason. Run it, measure it, then state it — especially about CI, Docker, production.
- Docs only when they change what I do next.

If the direct version has a real cost — data loss, a broken card in chat, an interrupted session —
name it in a sentence or two and proceed. Do not turn it into a menu of options.

# Language

The repository is English-only: code, comments, identifiers, commit messages, test names, log and
error messages, docs. Russian belongs only to product content — UI strings, locale files, bot copy,
post text. That is data, not code. Convert Russian comments in lines you are already editing; do not
open unrelated files to translate them.

# Workflow

Work on `main`. No branches, no PRs. Typecheck, tests, and a production build before every push.
CI/CD deploys `alex` from `main`. The `maru` container is deployed by hand — an unchanged Maru
revision after a push is expected; never deploy it unless asked.

# Persistence boundaries

`BackendDb` is the application handle; raw SQLite only through the explicitly named `unsafeDb(...)`.
Studio and Content go through persistence ports, and their exception set in the architecture tests
must stay empty. Publishing, Delivery, and Channels use ports for new logic; their existing worker
and reconciliation transactions remain `unsafeDb(...)` until a focused refactor moves them.
Analytics, Operations read models, Observability, and Engagement may read Drizzle directly.

# Runtime diagnostics

Start any worker, queue, configuration, publication, or error investigation with
`bun run --filter @alexgetman/backend ops guide --json`. It is read-only and it is the source of
truth for the command catalog and for whether the local route is usable. If it reports `local.state`
as `missing` or `unusable`, do not repair `/data` or seed a local database — use the production
command it prints.

Production is `ssh tw-nl`, containers `alexgetman-backend` and `maru-backend`, and direct execution
needs `docker exec -u bun <container> bun /app/ops/cli.js <command>` because the entrypoint starts as
root. For a missing publication start with `audit`; it covers both the text and video pipelines. When the
complaint is "post X did not go to Y", `recent` is the whole diagnosis: it names the last posts by
headline, their targets, and the targets each one is missing — then `retry --ref <ref> --target <y>`.
`find --query "text"` resolves a ref when the post is older. Never open the production database by hand.
Get CLI output before reading source for production state.

**Never run a mutation without an explicit request** — `backup`, `restore`, `--apply` variants,
`capability-record`, channel connect/disable, retry/republish, manual SQL, deployments.

# Local data

`bun scripts/dev-seed.ts` seeds site and dashboard fixtures and prints the launch line and both
URLs; `--no-dashboard` skips ~4k metric rows. The dashboard renders its login screen unless
`COMMAND_CENTER_TOKEN` matches the token in the URL (`.claude/launch.json` sets `dev`). An empty database is normal, not a bug — never write
INSERTs by hand. Change fixture shape in `apps/web/src/server/site-fixture.ts` (public read model)
or `apps/web/src/server/dashboard-fixture.ts` (Command Center), not in the seed script. The
dashboard fixture is deliberately not all-green, and audience counts read `—` locally because they
come from live platform APIs.

happy-dom does not compute layout: `offsetTop`, `clientHeight`, and `scrollTop` are always 0 there,
so player geometry and scrolling can only be verified in a real browser.

# Theming

Two skins, one vocabulary: `apps/web/src/shared/styles/tokens.css` and
`apps/backend/src/interfaces/web/dashboard/theme.ts`. Names match, values deliberately do not.
`themeContract.test.ts` fails if a shared token is missing from either file in either theme.
**Never write a raw colour in CSS** — only `var(--*)`. The theme is `data-theme` on `<html>`, set by
an inline script before first paint.

Player chrome has its own rules in `apps/web/src/scripts/story-player/AGENTS.md`.
