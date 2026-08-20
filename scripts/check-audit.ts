/** Fails on every high-severity dependency advisory. */
const child = Bun.spawn(["bun", "audit", "--audit-level=high"], {
  cwd: new URL("../", import.meta.url).pathname,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await child.exited) !== 0) {
  console.error("\nHigh-severity dependency advisory. Update the affected dependency.");
  process.exit(1);
}
