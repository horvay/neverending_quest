/**
 * Builds the hosted book into a static folder for the Cloudflare relay to
 * serve: `index.html`, `app.js`, `book.css`, and the book's images.
 *
 * `app.js` is the unchanged book plus the Home surface, Play Loop and routes
 * `nq serve` runs, bundled for the browser:
 *   - `node:fs` / `fs/promises` → the OPFS-backed tree in browser/vfs.ts;
 *   - `os`, `crypto`, `child_process` → small browser shims;
 *   - OMP, OpenTUI and Bun imports → generated inert stubs (a warning if called).
 *     The hosted app injects its own Game Master and Provider, so those code
 *     paths never run in the browser;
 *   - public Seed Packs (tracked in git) and the prompt markdown ride along
 *     as in-memory files.
 *
 *   bun run src/surfaces/hosted/build.ts [outDir]
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BunPlugin } from "bun";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SRC = path.join(ROOT, "src");
const WEB = path.join(SRC, "surfaces/web/client");
const SHIM_DIR = path.join(import.meta.dir, "browser/node");

const NODE_SHIMS: Record<string, string> = {
  fs: "fs.ts",
  "fs/promises": "fs_promises.ts",
  os: "os.ts",
  crypto: "crypto.ts",
  child_process: "child_process.ts",
  url: "url.ts",
};

/** Where code that reads `import.meta.dir` finds its neighbours in the browser. */
function browserDir(file: string): string {
  return `/app/${path.relative(ROOT, path.dirname(file))}`;
}

/**
 * Only public Seed Packs ship: tracked in git and not matched by an ignore
 * rule. The repo ignores private packs (local only) even where an older
 * commit still tracks them, and the hosted book is public.
 */
async function publicPackFiles(): Promise<string[]> {
  const git = async (...args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { cwd: ROOT, stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) {
      throw new Error("git failed; cannot tell public Seed Packs from private ones");
    }
    return out.split("\0").filter(Boolean);
  };
  const tracked = await git("ls-files", "-z", "packs");
  const ignored = new Set(await git("ls-files", "-z", "-c", "-i", "--exclude-standard", "packs"));
  return tracked.filter((rel) => !ignored.has(rel)).map((rel) => path.join(ROOT, rel));
}

async function bundledFiles(): Promise<Record<string, Record<string, string>>> {
  const packsDir = path.join(ROOT, "packs");
  const packs: Record<string, string> = {};
  for (const file of await publicPackFiles()) {
    packs[path.relative(packsDir, file)] = await readFile(file, "utf8");
  }
  const app: Record<string, string> = {};
  for (const name of await readdir(path.join(SRC, "play"))) {
    if (name.endsWith(".md")) {
      app[`src/play/${name}`] = await readFile(path.join(SRC, "play", name), "utf8");
    }
  }
  return { "/packs": packs, "/app": app };
}

/** Names `importer` takes from `specifier`, so the stub can export each one. */
function importedNames(source: string, specifier: string): string[] {
  const names = new Set<string>();
  const esc = specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const re = new RegExp(`(?:import|export)\\s+(?:type\\s+)?([^;]*?)\\s+from\\s+["']${esc}["']`, "g");
  for (const m of source.matchAll(re)) {
    const clause = m[1]!;
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1]!.split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
        if (name && name !== "default") names.add(name);
      }
    }
  }
  return [...names];
}

function stubModule(specifier: string, names: string[]): string {
  const exports = names.map((n) => `export const ${n} = stub(${JSON.stringify(n)});`).join("\n");
  // Inert rather than throwing: local-engine modules build schemas with OMP
  // while loading, though nothing the hosted book runs uses them. Only a call
  // after boot (browser/main.ts sets the flag) is worth a warning.
  return `
const warned = new Set();
function stub(name) {
  return new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive || key === "then" ? undefined : stub(name + "." + String(key))),
    apply: () => {
      if (globalThis.__nqBooted && !warned.has(name)) {
        warned.add(name);
        console.warn(name + " (${specifier}) is not available in the hosted build");
      }
      return stub(name + "()");
    },
    construct: () => stub("new " + name),
  });
}
export default stub("default");
${exports}
`;
}

export function hostedPlugin(files: Record<string, Record<string, string>>): BunPlugin {
  return {
    name: "nq-hosted",
    setup(build) {
      build.onResolve({ filter: /^(node:)?(fs|fs\/promises|os|crypto|child_process|url)$/ }, (args) => ({
        path: path.join(SHIM_DIR, NODE_SHIMS[args.path.replace(/^node:/, "")]!),
      }));
      // one stub per importer, exporting exactly the names that file takes
      build.onResolve({ filter: /^(@oh-my-pi\/|@opentui\/|bun$|bun:)/ }, (args) => ({
        path: `${args.path}|${args.importer}`,
        namespace: "nq-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "nq-stub" }, async (args) => {
        const [specifier, importer] = args.path.split("|") as [string, string];
        const source = await readFile(importer, "utf8").catch(() => "");
        return { contents: stubModule(specifier, importedNames(source, specifier)), loader: "js" };
      });
      build.onResolve({ filter: /^virtual:nq-bundled-files$/ }, () => ({
        path: "bundled-files",
        namespace: "nq-virtual",
      }));
      build.onLoad({ filter: /.*/, namespace: "nq-virtual" }, () => ({
        contents: `export default ${JSON.stringify(files)};`,
        loader: "js",
      }));
      build.onLoad({ filter: /\/src\/.*\.tsx?$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        if (!source.includes("import.meta.dir")) return undefined;
        return {
          contents: source.replaceAll("import.meta.dir", JSON.stringify(browserDir(args.path))),
          loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
        };
      });
    },
  };
}

export async function buildHosted(opts: { outDir: string; minify?: boolean }): Promise<void> {
  const outDir = path.resolve(opts.outDir);
  const files = await bundledFiles();
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "browser/main.ts")],
    target: "browser",
    format: "esm",
    splitting: false,
    minify: opts.minify ?? true,
    plugins: [hostedPlugin(files)],
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!built.success) {
    throw new Error(built.logs.map((l) => String(l)).join("\n") || "hosted bundle failed");
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "app.js"), await built.outputs[0]!.text());
  const diceCss = await readFile(
    new URL(import.meta.resolve("@gnuton/css-dice-roller/style.css")),
    "utf8",
  );
  await writeFile(
    path.join(outDir, "book.css"),
    `${await readFile(path.join(WEB, "book.css"), "utf8")}\n${diceCss}`,
  );
  const html = (await readFile(path.join(WEB, "index.html"), "utf8")).replace(
    "</head>",
    '    <link rel="icon" type="image/webp" href="/ink/seal.webp" />\n  </head>',
  );
  await writeFile(path.join(outDir, "index.html"), html);
  await cp(path.join(WEB, "ink"), path.join(outDir, "ink"), { recursive: true });
  await cp(path.join(WEB, "dice"), path.join(outDir, "dice"), { recursive: true });
}

if (import.meta.main) {
  const outDir = process.argv[2] ?? path.join(ROOT, "dist/hosted");
  await buildHosted({ outDir });
  console.log(`built the hosted book into ${path.relative(process.cwd(), outDir) || "."}`);
}
