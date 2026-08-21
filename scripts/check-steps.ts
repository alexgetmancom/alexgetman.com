/** The one list of checks the repo runs before code leaves the machine.
 *
 * check-all.ts and check-prepush.ts used to each hold their own copy, and they
 * had drifted: pre-push also ran svelte-check, so a green `check:all` could still
 * be rejected on push. They now differ only in scheduling — check-all runs the
 * list serially for readable output, pre-push runs the independent groups in
 * parallel for speed.
 *
 * Layer boundaries are the `layers` step (dependency-cruiser); there is no
 * separate architecture test to schedule ahead of it. */
export type CheckStep = { name: string; args: string[] };

/** Ordered: each group may only start once the previous one passed. */
export const CHECK_GROUPS: CheckStep[][] = [
  [{ name: "language", args: ["check:language"] }],
  [
    { name: "lint", args: ["lint"] },
    { name: "knip", args: ["knip"] },
    { name: "layers", args: ["check:layers"] },
    { name: "docker workspaces", args: ["check:docker"] },
    { name: "typecheck", args: ["typecheck"] },
    { name: "svelte", args: ["check:svelte"] },
  ],
  [
    { name: "test", args: ["test"] },
    { name: "web", args: ["check:web"] },
    { name: "backend", args: ["--filter", "@solo-publisher/backend", "build"] },
  ],
];
