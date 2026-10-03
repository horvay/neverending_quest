/**
 * Campaign tools for the hosted Game Master, run in the browser against the
 * Campaign folder (OPFS there, the real disk under tests). The Campaign
 * Sandbox is the same one the OMP adapter uses: every call passes
 * `guardToolCall` first, so the path jail and write protections hold.
 *
 * `roll`, `search`, `search_full` and `archive` are the game core's domain
 * tools (src/play/gm_tools.ts), shared with the OMP adapter. OMP's own
 * `read` / `edit` / `write` (hashline patches) are replaced here with plain
 * read and exact-string replace, which chat models follow without a patch
 * grammar.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gmTools, type GmTool } from "../../play/gm_tools.ts";
import { guardToolCall, toolUnavailableMessage, type Sandbox } from "../../play/sandbox.ts";

export type ToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ToolRun = { text: string; isError: boolean };

const INTENT = { type: "string", description: "concise intent" };
const MAX_READ_LINES = 2000;

function spec(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolSpec {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: { i: INTENT, ...properties },
        required: [...required, "i"],
        additionalProperties: false,
      },
    },
  };
}

/** No search_full knobs: the hosted Game Master has one model. */
const GAME_TOOLS = new Map<string, GmTool>(gmTools().map((tool) => [tool.name, tool]));

const SPECS: Record<string, ToolSpec> = {
  read: spec(
    "read",
    "Read a Campaign file (text returned verbatim) or list a directory. `offset` is the 1-based first line and `limit` the line count, for long files.",
    {
      path: { type: "string", description: "Campaign-relative path, e.g. dossiers/mara.md" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    ["path"],
  ),
  edit: spec(
    "edit",
    "Surgical edit of an existing Campaign file: replace `old_string` with `new_string`. `old_string` must match the file exactly (copy it from a fresh `read`, including line breaks) and must be unique unless `replace_all` is true. Keep each edit small; unrelated text stays untouched.",
    {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    ["path", "old_string", "new_string"],
  ),
  write: spec(
    "write",
    "Create a new Campaign file with `content`, e.g. a new dossier at dossiers/<slug>.md. Existing dossiers take `edit`, never `write`.",
    { path: { type: "string" }, content: { type: "string" } },
    ["path", "content"],
  ),
  ...Object.fromEntries(
    [...GAME_TOOLS.values()].map((tool) => [
      tool.name,
      spec(tool.name, tool.description, tool.parameters.properties, [
        ...tool.parameters.required,
      ]),
    ]),
  ),
};

export function toolSpecs(names: readonly string[]): ToolSpec[] {
  return names.flatMap((name) => (SPECS[name] ? [SPECS[name]!] : []));
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

/** Runs one tool call. Failures come back as text for the model, never throw. */
export async function runTool(
  sandbox: Sandbox,
  allowed: readonly string[],
  name: string,
  args: Record<string, unknown>,
): Promise<ToolRun> {
  const fail = (text: string): ToolRun => ({ text, isError: true });
  if (!allowed.includes(name)) return fail(toolUnavailableMessage(name, allowed));
  const game = GAME_TOOLS.get(name);
  if (game) {
    try {
      return { text: await game.run(sandbox, args), isError: false };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
  // the file tools; guardToolCall refuses any other name
  const guard = await guardToolCall(sandbox, name, args);
  if (!guard.ok) return fail(guard.error);
  try {
    switch (name) {
      case "read": {
        const abs = await sandbox.resolvePath(str(args, "path"));
        const info = await stat(abs).catch(() => null);
        if (!info) return fail(`No such file: ${str(args, "path")}`);
        if (info.isDirectory()) {
          const entries = await readdir(abs, { withFileTypes: true });
          const listing = entries
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort()
            .join("\n");
          return { text: listing || "(empty directory)", isError: false };
        }
        const lines = (await readFile(abs, "utf8")).split("\n");
        const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
        const limit = Math.max(1, Math.floor(Number(args.limit) || MAX_READ_LINES));
        const shown = lines.slice(offset - 1, offset - 1 + limit);
        const more = offset - 1 + shown.length < lines.length;
        return {
          text:
            shown.join("\n") +
            (more
              ? `\n\n[${lines.length - (offset - 1 + shown.length)} more lines; read with offset ${offset + shown.length}]`
              : ""),
          isError: false,
        };
      }
      case "edit": {
        const abs = await sandbox.resolvePath(str(args, "path"));
        const before = await readFile(abs, "utf8").catch(() => null);
        if (before === null) return fail(`No such file: ${str(args, "path")}. Create files with write.`);
        const oldText = str(args, "old_string");
        const newText = str(args, "new_string");
        if (!oldText) return fail("old_string must not be empty");
        const count = before.split(oldText).length - 1;
        if (count === 0) {
          return fail("old_string was not found. read the file again and copy the text exactly.");
        }
        if (count > 1 && args.replace_all !== true) {
          return fail(`old_string matches ${count} places; include more surrounding text or set replace_all.`);
        }
        const after =
          args.replace_all === true
            ? before.split(oldText).join(newText)
            : before.replace(oldText, () => newText);
        await writeFile(abs, after);
        return { text: `Edited ${str(args, "path")}.`, isError: false };
      }
      case "write": {
        const abs = await sandbox.resolvePath(str(args, "path"));
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, str(args, "content"));
        return { text: `Wrote ${str(args, "path")}.`, isError: false };
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
