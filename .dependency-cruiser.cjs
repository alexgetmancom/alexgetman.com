/** Layer boundaries, checked on the resolved module graph.
 *
 * This complements apps/backend/tests/studioArchitecture.test.ts rather than
 * replacing it: that test asserts specific wiring ("Operations dispatch calls
 * action-audit") and source-level facts a graph cannot see. What it cannot do is
 * cover a layer by shape — its file lists are written by hand, so a module added
 * to delivery/ tomorrow is unguarded until someone remembers to list it. The
 * rules here are globs over the whole graph, and they also catch cycles, which
 * nothing else in the repo looked for.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "A cycle means neither module can be understood, tested or moved on its own.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "grammy-only-in-telegram",
      comment: "The Telegram SDK is an interface detail. Core layers speak in domain types and codes, never in grammy Contexts.",
      severity: "error",
      // api.ts is on this list because it terminates the Telegram webhook and
      // hands the update to bot.handleUpdate — it is a transport adapter that
      // happens to sit at the top of src/ rather than under interfaces/.
      from: { path: "^apps/backend/src/", pathNot: "^apps/backend/src/(bot/|bot\\.ts|api\\.ts|interfaces/telegram/)" },
      // Matched on the resolved path's final node_modules segment, not on the
      // specifier: bun resolves grammy to node_modules/.bun/grammy@1.45.1/...,
      // so a regex anchored at the start of the path silently matches nothing.
      to: { dependencyTypes: ["npm"], path: "node_modules/(grammy|@grammyjs)/" },
    },
    {
      name: "foundation-is-a-leaf",
      comment: "foundation/ is imported by everything; if it imports back, every layer is transitively coupled to every other.",
      severity: "error",
      from: { path: "^apps/backend/src/foundation/" },
      to: { path: "^apps/backend/src/(bot/|interfaces/|studio/|delivery/|publishing/|analytics/|operations/|engagement/|content/)" },
    },
    {
      name: "domain-is-a-leaf",
      severity: "error",
      from: { path: "^apps/backend/src/domain/" },
      to: { path: "^apps/backend/src/(bot/|interfaces/|studio/|delivery/|publishing/|analytics/|operations/|engagement/|content/)" },
    },
    {
      name: "no-interface-deps-in-core",
      comment:
        "Core layers must not depend on how their output is presented. The one exclusion is operations/dashboard, which is an HTML " +
        "renderer filed under operations by history rather than by design — it belongs in interfaces/web/ and is excluded here so " +
        "the rule can be enforced today rather than after that move.",
      severity: "error",
      from: {
        path: "^apps/backend/src/(delivery/|publishing/|analytics/|content/|operations/|engagement/|public/)",
        pathNot: "^apps/backend/src/operations/dashboard",
      },
      to: { path: "^apps/backend/src/(bot/|interfaces/)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: [".ts", ".js", ".json"] },
    // Orphan detection is deliberately off: every Astro page, script and worker
    // entry reads as an orphan here, and knip already answers that question with
    // the right entry points configured.
  },
};
