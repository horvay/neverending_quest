/**
 * Fails when an import crosses a layer the wrong way. The layers, from the
 * bottom up:
 *
 *   packages/*      engines, seal transport — nothing from src/
 *   src/campaign    the Campaign folder and its history
 *   src/play        the game core (Play Loop, Kernel, Context Assembly)
 *   src/config.ts   the nq config file, a PlayConfig plus player settings
 *   src/agent, src/dev    Game Masters behind play's agent port
 *   src/home        Home: Provider, Campaign library, local setup
 *   src/surfaces    TUI, web book, hosted book
 *   src/cli.ts      the composition root
 *
 * Other root modules beside cli.ts (model_selector, toml_lite) are shared.
 *
 *   bun scripts/check_layers.ts
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/** Layer of a repo-relative file, or null for files outside the layering. */
function layerOf(rel: string): string | null {
  if (rel.startsWith("packages/")) return "packages";
  const m = /^src\/([^/]+)/.exec(rel);
  if (!m) return null;
  if (rel === "src/cli.ts") return "cli";
  if (rel === "src/config.ts") return "config";
  if (!rel.slice(4).includes("/")) return "shared";
  return m[1]!;
}

/** What each layer may import, besides itself, shared root modules and packages. */
const ALLOWED: Record<string, readonly string[]> = {
  packages: [],
  shared: [],
  campaign: [],
  play: ["campaign"],
  config: ["play", "campaign"],
  agent: ["config", "play", "campaign"],
  dev: ["play", "campaign", "agent"],
  home: ["config", "play", "campaign"],
  surfaces: ["home", "config", "play", "campaign", "agent"],
  cli: ["surfaces", "home", "config", "play", "campaign", "agent", "dev"],
};

const SPEC = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

async function* sources(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(abs);
    else if (/\.tsx?$/.test(entry.name)) yield abs;
  }
}

const problems: string[] = [];
for (const top of ["src", "packages"]) {
  for await (const abs of sources(path.join(ROOT, top))) {
    const rel = path.relative(ROOT, abs);
    const from = layerOf(rel);
    if (!from) continue;
    const text = await readFile(abs, "utf8");
    for (const m of text.matchAll(SPEC)) {
      const spec = m[1]!;
      let to: string | null;
      if (spec.startsWith("@nq/")) to = "packages";
      else if (spec.startsWith(".")) {
        to = layerOf(path.relative(ROOT, path.resolve(path.dirname(abs), spec)));
      } else continue;
      if (!to || to === from || to === "packages") continue;
      if (to === "shared" && from !== "packages") continue;
      if (ALLOWED[from]?.includes(to)) continue;
      problems.push(`${rel}: ${from} must not import ${to} (${spec})`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("layers ok");
