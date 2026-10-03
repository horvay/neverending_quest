/**
 * bun run watch [-- serve args…]
 *
 * Restarts nq serve when server source changes, and (via NQ_WATCH)
 * rebuilds the book assets in-process when src/surfaces/web/client/ changes.
 */
process.env.NQ_WATCH = "1";

process.argv = [
  process.argv[0]!,
  new URL("../src/cli.ts", import.meta.url).pathname,
  "serve",
  ...process.argv.slice(2),
];

await import("../src/cli.ts");
