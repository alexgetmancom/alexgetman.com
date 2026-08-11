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
CI/CD deploys the primary production revision from `main`. Secondary container revisions are
deployed by hand; an unchanged secondary revision after a push is expected, and must not be
deployed unless asked.

# Persistence boundaries

`BackendDb` is the application handle; raw SQLite only through the explicitly named `unsafeDb(...)`.
Studio and Content go through persistence ports, and their exception set in the architecture tests
must stay empty. Publishing, Delivery, and Channels use ports for new logic; their existing worker
and reconciliation transactions remain `unsafeDb(...)` until a focused refactor moves them.
Analytics, Operations read models, Observability, and Engagement may read Drizzle directly.

# Runtime diagnostics

Start any worker, queue, configuration, publication, or error investigation with
`bun run --filter @alexgetman/backend ops guide --json`. It is read-only and it is the source of
truth for whether the local route is usable. If it reports `local.state` as `missing` or `unusable`,
do not repair `/data` or seed a local database — use the production command it prints. Its command
catalog describes **this working tree**: when it routes you to production, read the deployed catalog
with `bun run ops:prod guide --json`, because the container runs its last deployed revision
and a command committed but not yet deployed comes back as `unknown command`. `guide.catalog` says
which case you are in.

Production access is configured locally in the ignored `.env.local` file with `OPS_SSH_TARGET` and,
optionally, `OPS_CONTAINER`. Use `bun run ops:prod <command>` for every production operation; it
executes the bundled CLI as the container's unprivileged runtime user. For a missing publication start
with `audit`; it covers both the text and video pipelines. When the
complaint is "post X did not go to Y", `recent` is the whole diagnosis: it names the last posts by
headline, their targets, and the targets each one is missing — then `retry --ref <ref> --target <y>`,
which reports the targets in scope and needs `--apply` to queue them. Every command that reaches an
audience works this way: `retry`, `edit`, `replace-media`, `use-other-media`, `delete`.
`find --query "text"` resolves a ref when the post is older. Never open the production database by hand.
Get CLI output before reading source for production state.

**Never run a mutation without an explicit request** — `backup`, `restore`, `--apply` variants,
`capability-record`, channel connect/disable, `retry`, manual SQL, deployments.

Every operation is one entry in `apps/backend/src/operations/registry.ts`: summary, zod schema,
`mutates`, `agent`, handler, optional text formatter. The CLI dispatch, the `--help` and `guide`
catalogs, and the `ops_*` MCP tools are all projections of it — adding an entry is the whole change,
and a usage string is never written by hand. `agent: false` keeps an operation off MCP; that is the
line for anything moving the database file, writing credentials, or reading a host path.

# X analytics imports

Handed an X Analytics CSV, import it without asking:

    bun run ops:prod import-x-analytics --file <path> --sampled-at <file mtime, ISO UTC>
    bun run ops:prod x-analytics

`ops:prod` copies a local `--file`/`--x-file` into the container and removes it afterwards, so a Mac
path is the right argument. `--sampled-at` is the export's own timestamp — the file's mtime, never
`now` — because it stamps the metric history. Re-importing a byte-identical file is a no-op by
SHA-256, so a repeat costs nothing; a re-export of the same period is a new file and a new sample.

An import stores rows as account-wide activity and then runs the linker over the whole table, so a
post written after an earlier export still picks up its history. `x-relink` is that same pass on its
own — it reports its plan and writes only with `--apply` — and it is what to run after the matching
rule changes, because a byte-identical CSV is a no-op and will not re-link anything.

`x-analytics` is the read-only account of the result: per-import row counts, linked vs unlinked
activity, editorial X targets no export covers, and `linkCandidates` — unlinked items whose text
matches exactly one editorial post but is shorter than the linker's 30-character bar. Candidates are
reported, never linked: the bar lives in `x-post-matching.ts` and is the only place to change it.
X caps an export's rows, so a three-month window returns *fewer* posts than a two-week one. Long
windows extend history; they do not replace the dense recent export.

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
