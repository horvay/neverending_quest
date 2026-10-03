/**
 * The Game Master's domain tools — `roll`, `search`, `search_full` and
 * `archive` — defined once: name, the description and parameters the model
 * sees, and how a call runs against the Campaign Sandbox. Each Game Master
 * adapter wraps these in its own tool format (OMP custom tools locally, chat
 * completion functions in the hosted browser agent).
 *
 * The file tools (`read` / `edit` / `write`) are not here: each adapter has
 * its own, and both pass them through `guardToolCall`.
 */
import { archiveDossier, slugFromArchiveArg } from "../campaign/dossiers.ts";
import { guardToolCall, type Sandbox, type SearchHit } from "./sandbox.ts";
import { searchFull } from "./search_full.ts";

export const GM_TOOL_NAMES = ["roll", "search", "search_full", "archive"] as const;

export type GmToolName = (typeof GM_TOOL_NAMES)[number];

/** A flat JSON Schema object: every parameter is a string, number or boolean. */
export type GmToolParameters = {
  type: "object";
  properties: Record<string, { type: "string" | "number" | "boolean" }>;
  required: readonly string[];
};

export type GmTool = {
  name: GmToolName;
  /** Short display name. */
  label: string;
  description: string;
  parameters: GmToolParameters;
  /**
   * Runs one call, Sandbox guard first. The text is the tool result for the
   * model; a refused or failed call throws, and its message is for the model.
   */
  run(sandbox: Sandbox, args: Record<string, unknown>): Promise<string>;
};

/** How `search_full` should recall, when the player configured it. */
export type GmToolKnobs = {
  searchFullModel?: string;
  searchFullReasoning?: string;
};

/** The domain tools, in GM_TOOL_NAMES order. */
export function gmTools(knobs?: GmToolKnobs): GmTool[] {
  const searchFullDescBits = [
    "Deeper recall over memory markdown plus player-facing transcript (never .nq/**).",
  ];
  if (knobs?.searchFullModel) {
    searchFullDescBits.push(`Preferred model: ${knobs.searchFullModel}.`);
  }
  if (knobs?.searchFullReasoning) {
    searchFullDescBits.push(`Reasoning: ${knobs.searchFullReasoning}.`);
  }

  return [
    {
      name: "roll",
      label: "Roll",
      description:
        "Roll a fair die: uniform integer in [1, n]. Used for randomized list or uncertain outcomes. Put the stake in the tool intent — a short phrase the player will see (what is being decided).",
      parameters: params({ n: "number" }, ["n"]),
      async run(sandbox, args) {
        await guard(sandbox, "roll", args);
        return String(await sandbox.roll(args.n as number));
      },
    },
    {
      name: "search",
      label: "Search",
      description:
        "Deterministic search over prescribed Campaign memory markdown (no transcript, no .nq).",
      parameters: params({ query: "string", includeSeed: "boolean" }, ["query"]),
      async run(sandbox, args) {
        await guard(sandbox, "search", args);
        const hits = await sandbox.search(str(args, "query"), {
          includeSeed: args.includeSeed === true,
        });
        return hits.length === 0 ? "No hits." : hitsText(hits);
      },
    },
    {
      name: "search_full",
      label: "Search full",
      description: searchFullDescBits.join(" "),
      parameters: params({ query: "string" }, ["query"]),
      async run(sandbox, args) {
        await guard(sandbox, "search_full", args);
        const result = await searchFull(sandbox, str(args, "query"), {
          model: knobs?.searchFullModel,
          reasoning: knobs?.searchFullReasoning,
        });
        return result.hits.length === 0
          ? result.summary
          : `${result.summary}\n${hitsText(result.hits)}`;
      },
    },
    {
      name: "archive",
      label: "Archive",
      description:
        "Move a Dossier to dossiers/archive/ (archive=true, default) or back to dossiers/ (archive=false). Same slug. Search still finds it; the catalog pin does not. Never delete. Refuse if the other path already exists.",
      parameters: params({ slug: "string", archive: "boolean" }, ["slug"]),
      async run(sandbox, args) {
        const raw = str(args, "slug");
        const slug = slugFromArchiveArg(raw);
        await guard(sandbox, "archive", { ...args, slug: slug ?? raw });
        const result = await archiveDossier(
          sandbox.campaignRoot,
          raw,
          args.archive !== false,
        );
        const verb = result.archived ? "archived" : "restored";
        return result.moved
          ? `${verb} ${result.from} → ${result.to}`
          : `already ${verb}: ${result.to}`;
      },
    },
  ];
}

function params(
  properties: Record<string, "string" | "number" | "boolean">,
  required: readonly string[],
): GmToolParameters {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, type]) => [key, { type }]),
    ),
    required,
  };
}

async function guard(
  sandbox: Sandbox,
  name: GmToolName,
  args: Record<string, unknown>,
): Promise<void> {
  const verdict = await guardToolCall(sandbox, name, args);
  if (!verdict.ok) throw new Error(verdict.error);
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

function hitsText(hits: SearchHit[]): string {
  return hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n");
}
