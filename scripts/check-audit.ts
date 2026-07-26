/** Dependency vulnerability gate.
 *
 * `bun audit` on its own is not usable as a CI check here: the tree carries
 * four advisories that no compatible update can clear (verified — `bun update`
 * moves none of them), because the vulnerable versions are pinned inside
 * astro's and drizzle-kit's own ranges. A check that is red on arrival gets
 * ignored, so the known four are listed below with the reason they are
 * tolerable, and anything *new* at high or above fails the build.
 *
 * This list is a debt register, not a suppression file. When astro or
 * drizzle-kit ship a fix, drop the entry — a stale id here is silent.
 */
const ACCEPTED = [
  // astro › vite › postcss, build-time only: the path traversal needs an
  // attacker-authored sourceMappingURL in CSS we compile ourselves.
  "GHSA-r28c-9q8g-f849",
  // astro › svgo, build-time only: SVGs come from the repo and the media
  // pipeline, never from user upload.
  "GHSA-2p49-hgcm-8545",
  // @astrojs/rss › fast-xml-parser: we only ever *generate* the feed. Nothing
  // in this repo parses untrusted XML with it.
  "GHSA-8r6m-32jq-jx6q",
];

const child = Bun.spawn(["bun", "audit", "--audit-level=high", ...ACCEPTED.map((id) => `--ignore=${id}`)], {
  cwd: new URL("../", import.meta.url).pathname,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await child.exited) !== 0) {
  console.error("\nNew high-severity advisory. Fix it, or add the id to ACCEPTED in scripts/check-audit.ts with a reason.");
  process.exit(1);
}
