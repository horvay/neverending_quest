import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { listDossierRels } from "../campaign/dossiers.ts";
import { GENERATED_DOSSIER_CATALOG_PATH } from "../campaign/catalog.ts";
import {
  CAMPAIGN_YAML,
  ILLUSTRATIONS_DIR,
  NQ_DIR,
  PLAYER_SHEET_MD,
  QUEST_LOG_MD,
  SEED_MD,
  STORY_BEATS_MD,
  TRANSCRIPT_JSONL,
  TWISTS_MD,
  WORLD_BUILDING_MD,
} from "../campaign/paths.ts";

export const PLAY_TOOL_NAMES = [
  "read",
  "roll",
  "search",
  "search_full",
] as const;

export const HYGIENE_TOOL_NAMES = [
  "read",
  "edit",
  "write",
  "search",
  "search_full",
  "archive",
] as const;

/**
 * Every tool a play session offers the model, for its whole life. The tool
 * schemas sit at the top of the prompt, so changing them per pass would make
 * the engine re-read the whole conversation; each pass instead narrows what
 * may be called (PLAY_TOOL_NAMES, HYGIENE_TOOL_NAMES) when a call is made.
 */
export const SESSION_TOOL_NAMES = [
  "read",
  "edit",
  "write",
  "roll",
  "search",
  "search_full",
  "archive",
] as const;

/**
 * The Campaign file tools. Each Game Master adapter brings its own, and every
 * call passes `guardToolCall` before it touches the Campaign folder.
 */
export const FILE_TOOL_NAMES = ["read", "edit", "write"] as const;

export function isFileToolName(
  name: string,
): name is (typeof FILE_TOOL_NAMES)[number] {
  return (FILE_TOOL_NAMES as readonly string[]).includes(name);
}

/** What the model is told when it calls a tool the current pass may not use. */
export function toolUnavailableMessage(
  name: string,
  allowed: Iterable<string>,
): string {
  return `${name} is not available now. Use only: ${[...allowed].join(", ")}.`;
}

/** Illustration rewrite may look up memory. It may not write. */
export const ILLUSTRATION_READ_TOOLS = [
  "read",
  "search",
  "search_full",
] as const;

const PROTECTED_WRITE_EXACT: Record<string, true> = {
  [CAMPAIGN_YAML]: true,
  [GENERATED_DOSSIER_CATALOG_PATH]: true,
  [TRANSCRIPT_JSONL]: true,
};

export type Sandbox = {
  campaignRoot: string;
  resolvePath(target: string): Promise<string>;
  mayWrite(target: string): Promise<boolean>;
  validateRoll(n: number): void;
  roll(n: number): Promise<number>;
  search(query: string, opts?: { includeSeed?: boolean }): Promise<SearchHit[]>;
};

export type SearchHit = {
  path: string;
  line: number;
  text: string;
};

export type SandboxOptions = {
  campaignRoot: string;
  random?: () => number;
  maxRollN?: number;
  resolveRoll?: (n: number, naturalRoll: () => number) => Promise<number | undefined>;
};

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const root = path.resolve(opts.campaignRoot);
  const rootReal = await realpath(root).catch(() => root);
  const random = opts.random ?? Math.random;
  const maxRollN = opts.maxRollN ?? 1_000_000;

  async function resolvePath(target: string): Promise<string> {
    const abs = path.resolve(root, target);
    const relFromReal = path.relative(rootReal, abs);
    const relFromRoot = path.relative(root, abs);
    const escaped =
      (relFromReal.startsWith("..") || path.isAbsolute(relFromReal)) &&
      (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot));
    if (escaped) {
      throw new SandboxError(`Path escapes Campaign folder: ${target}`);
    }
    const relNorm = toPosix(relFromRoot);
    if (relNorm === NQ_DIR || relNorm.startsWith(`${NQ_DIR}/`)) {
      throw new SandboxError(`Access denied to control path: ${relNorm}`);
    }
    if (
      relNorm === ILLUSTRATIONS_DIR ||
      relNorm.startsWith(`${ILLUSTRATIONS_DIR}/`)
    ) {
      throw new SandboxError(`Access denied to control path: ${relNorm}`);
    }
    return abs;
  }

  async function mayWrite(target: string): Promise<boolean> {
    try {
      const abs = await resolvePath(target);
      const rel = toPosix(path.relative(root, abs));
      if (PROTECTED_WRITE_EXACT[rel]) return false;
      if (rel === NQ_DIR || rel.startsWith(`${NQ_DIR}/`)) return false;
      if (rel === ILLUSTRATIONS_DIR || rel.startsWith(`${ILLUSTRATIONS_DIR}/`)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function validateRoll(n: number): void {
    if (!Number.isInteger(n) || n < 1) {
      throw new SandboxError(`roll n must be a positive integer, got ${n}`);
    }
    if (n > maxRollN) {
      throw new SandboxError(`roll n exceeds cap ${maxRollN}`);
    }
  }

  async function roll(n: number): Promise<number> {
    validateRoll(n);
    let naturalValue: number | undefined;
    const naturalRoll = (): number => {
      naturalValue ??= 1 + Math.floor(random() * n);
      return naturalValue;
    };
    const resolved = await opts.resolveRoll?.(n, naturalRoll);
    const value = resolved ?? naturalRoll();
    if (!Number.isInteger(value) || value < 1 || value > n) {
      throw new SandboxError(`resolved roll must be an integer in [1, ${n}]`);
    }
    return value;
  }

  async function search(
    query: string,
    searchOpts?: { includeSeed?: boolean },
  ): Promise<SearchHit[]> {
    if (!query || query.trim().length === 0) {
      throw new SandboxError("search query must be non-empty");
    }
    const files: string[] = [
      PLAYER_SHEET_MD,
      WORLD_BUILDING_MD,
      STORY_BEATS_MD,
      QUEST_LOG_MD,
      TWISTS_MD,
      ...(await listDossierRels(root)),
    ];
    if (searchOpts?.includeSeed) files.push(SEED_MD);

    const hits: SearchHit[] = [];
    for (const rel of files.sort()) {
      const abs = path.join(root, rel);
      let body: string;
      try {
        body = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.includes(query)) {
          hits.push({ path: rel, line: i + 1, text: line });
        }
      }
    }
    return hits;
  }

  return { campaignRoot: root, resolvePath, mayWrite, validateRoll, roll, search };
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

async function pathExists(target: string): Promise<boolean> {
  return stat(target)
    .then(() => true)
    .catch((err: unknown) => {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "ENOENT"
      ) {
        return false;
      }
      throw err;
    });
}

export async function guardToolCall(
  sandbox: Sandbox,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (name === "roll") {
      const n = args.n;
      if (typeof n !== "number") return { ok: false, error: "roll requires n: number" };
      sandbox.validateRoll(n);
      return { ok: true };
    }
    if (name === "search" || name === "search_full") {
      return { ok: true };
    }
    if (name === "archive") {
      const slug =
        typeof args.slug === "string" ? args.slug.trim() : "";
      if (!slug) return { ok: false, error: "archive requires slug" };
      return { ok: true };
    }
    if (isFileToolName(name)) {
      const target = extractToolPath(name, args);
      if (!target) return { ok: false, error: `${name} requires path` };
      const abs = await sandbox.resolvePath(target);
      const rel = toPosix(path.relative(sandbox.campaignRoot, abs));
      if (rel === GENERATED_DOSSIER_CATALOG_PATH) {
        return {
          ok: false,
          error:
            "dossier-catalog.md is generated prompt context, not a Campaign file. Use dossiers/<slug>.md.",
        };
      }
      if (
        name === "write" &&
        rel.startsWith("dossiers/") &&
        rel.endsWith(".md")
      ) {
        const match = /^dossiers\/([a-z0-9-]+)\.md$/.exec(rel);
        if (!match) {
          return {
            ok: false,
            error:
              "Create dossiers at dossiers/<slug>.md; use archive to move them.",
          };
        }
        const archived = path.join(
          sandbox.campaignRoot,
          "dossiers",
          "archive",
          `${match[1]}.md`,
        );
        if ((await pathExists(abs)) || (await pathExists(archived))) {
          return {
            ok: false,
            error:
              "Existing dossiers require surgical edits; write only creates a dossier.",
          };
        }
      }
      if (name === "edit" || name === "write") {
        const allowed = await sandbox.mayWrite(target);
        if (!allowed) {
          return { ok: false, error: `Write denied to protected path: ${target}` };
        }
      }
      return { ok: true };
    }
    return { ok: false, error: `Tool not allowlisted: ${name}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Resolve the filesystem target from stock tool args, including hashline edit payloads. */
export function extractToolPath(
  name: string,
  args: Record<string, unknown>,
): string {
  if (typeof args.path === "string" && args.path.trim()) return args.path.trim();
  if (typeof args.file_path === "string" && args.file_path.trim()) {
    return args.file_path.trim();
  }
  if (typeof args.target === "string" && args.target.trim()) {
    return args.target.trim();
  }
  if (name === "edit" && typeof args.input === "string") {
    return extractHashlineEditPath(args.input) ?? "";
  }
  return "";
}

/**
 * Hashline edit bodies start with `[path#TAG]` (optional leading whitespace).
 * Path may include directories; tag is alphanumeric.
 */
export function extractHashlineEditPath(input: string): string | null {
  const match = input.match(/^\s*\[([^\]#\r\n]+?)#[^\]]+\]/m);
  if (!match) return null;
  const p = match[1]!.trim();
  return p.length > 0 ? p : null;
}

