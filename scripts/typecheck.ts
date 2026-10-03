/**
 * `tsc --noEmit` over this repo, then the layer check. OMP ships TypeScript
 * source that does not pass our strict flags, and skipLibCheck only skips
 * .d.ts files, so diagnostics inside node_modules are dropped here.
 *
 *   bun run typecheck
 */
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const tsc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "--pretty", "false"], {
  cwd: root,
  stdout: "pipe",
  stderr: "inherit",
});
const ours = tsc.stdout
  .toString()
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("node_modules/") && !line.startsWith(" "));
if (ours.length > 0) {
  console.error(ours.join("\n"));
  process.exit(1);
}
const layers = Bun.spawnSync(["bun", path.join(import.meta.dir, "check_layers.ts")], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(layers.exitCode ?? 1);
