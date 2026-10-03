import path from "node:path";
import {
  dossierRel,
  slugFromArchiveArg,
  stampDossierFile,
} from "../campaign/dossiers.ts";
import type { ScratchRecord, ScratchTool } from "../campaign/types.ts";
import {
  parseRollValue,
  rollNFromArgs,
  rollReasonFromArgs,
  visibleRoll,
} from "./dice.ts";
import { extractToolPath } from "./sandbox.ts";
import { applyThinkingSnapshot } from "./scratch_format.ts";
import type { AgentSessionEvent, PlayEvent } from "./types.ts";

/** What the recorder needs from the Play Loop that owns it. */
export type ScratchRecorderHost = {
  emit(event: PlayEvent): void;
  /** The open Campaign folder, for Campaign-relative tool paths. */
  campaignRoot(): string | undefined;
  /** A tool finished; the session's occupancy may have grown. */
  onToolResult(): void;
};

/**
 * Captures Scratch for the run in progress (a Turn, a Memory Hygiene pass, or
 * an Illustration rewrite) from the agent's event stream and streams it live.
 * Also pairs `roll` calls with their results so the Roll Log gets the purpose
 * the Game Master gave when it asked.
 */
export class ScratchRecorder {
  private buffer: ScratchBuffer = emptyScratch();
  /** Opener shown in Scratch for the current run; unset on hidden passes. */
  private opener: string | undefined;
  private readonly pendingRoll = new Map<string, { n: number; reason?: string }>();

  constructor(private readonly host: ScratchRecorderHost) {}

  /** Thinking so far, which the repetition watcher reads. */
  get thinking(): string {
    return this.buffer.thinking;
  }

  reset(): void {
    this.buffer = emptyScratch();
    this.opener = undefined;
    this.pendingRoll.clear();
  }

  /** Reset for a play run whose reasoning starts from `opener` (llama.cpp only). */
  resetForTurn(opener: string | undefined): void {
    this.reset();
    if (opener) {
      this.opener = opener;
      this.buffer.thinking = opener;
    }
  }

  /** The stored shape of what was captured, less its `ts` and turn. */
  record(): Pick<ScratchRecord, "thinking" | "tools"> {
    return {
      thinking: this.buffer.thinking,
      tools: this.buffer.tools.map(publishedScratchTool),
    };
  }

  emitLive(): void {
    this.host.emit({ type: "scratch_live", ...this.record() });
  }

  ingest(ev: AgentSessionEvent): void {
    if (ev.type === "thinking_delta") {
      if (!ev.text) return;
      const opener = ev.snapshot ? this.opener : undefined;
      const text =
        opener && !ev.text.startsWith(opener) ? `${opener}${ev.text}` : ev.text;
      const next = ev.snapshot
        ? applyThinkingSnapshot(this.buffer.thinking, text)
        : this.buffer.thinking + text;
      if (next === this.buffer.thinking) return;
      this.buffer.thinking = next;
      this.emitLive();
      return;
    }
    if (ev.type === "tool_call") {
      this.buffer.tools.push(
        scratchToolFromCall(
          this.host.campaignRoot(),
          ev.name,
          ev.args,
          ev.intent,
          ev.toolCallId,
        ),
      );
      this.emitLive();
      return;
    }
    if (ev.type !== "tool_result") return;
    this.host.onToolResult();
    const tool = findScratchToolForResult(this.buffer.tools, ev);
    if (ev.name === "roll") {
      const value = parseRollValue(ev.result);
      if (!tool || value === undefined) return;
      tool.value = value;
      this.emitLive();
      return;
    }
    if (ev.name !== "edit" && ev.name !== "write") return;
    if (ev.isError || toolResultFailed(ev.result)) return;
    if (tool) tool.wrote = true;
    const root = this.host.campaignRoot();
    if (root && tool?.path) {
      void stampDossierFile(root, tool.path).catch(() => {
        // stamp is best-effort; SUCCESS sweep retries
      });
    }
    if (tool) this.emitLive();
  }

  /** Emits a `roll` event once a play roll resolves, with its stated purpose. */
  ingestRoll(ev: AgentSessionEvent): void {
    if (ev.type === "tool_call" && ev.name === "roll") {
      const n = rollNFromArgs(ev.args);
      if (n === undefined) return;
      const fromArgs = rollReasonFromArgs(ev.args);
      const fromIntent = ev.intent?.trim();
      const reason = fromArgs || fromIntent || undefined;
      this.pendingRoll.set(ev.toolCallId ?? "", { n, reason });
      return;
    }
    if (ev.type !== "tool_result" || ev.name !== "roll" || ev.isError) return;
    const key = ev.toolCallId ?? "";
    const pending = this.pendingRoll.get(key);
    this.pendingRoll.delete(key);
    const shown = visibleRoll(pending?.n, parseRollValue(ev.result));
    if (!shown) return;
    this.host.emit({
      type: "roll",
      n: shown.n,
      value: shown.value,
      ...(pending?.reason ? { reason: pending.reason } : {}),
    });
  }
}

type BufferedScratchTool = ScratchTool & { callId?: string };

type ScratchBuffer = {
  thinking: string;
  tools: BufferedScratchTool[];
};

const PATHLESS_TOOLS = new Set(["roll", "search", "search_full", "archive"]);

function emptyScratch(): ScratchBuffer {
  return { thinking: "", tools: [] };
}

function scratchToolFromCall(
  campaignRoot: string | undefined,
  name: string,
  args: unknown,
  intent?: string,
  toolCallId?: string,
): BufferedScratchTool {
  let tool: BufferedScratchTool;
  if (name === "roll") {
    const n = rollNFromArgs(args);
    const reason = rollReasonFromArgs(args) || intent?.trim() || undefined;
    tool = {
      name,
      ...(n !== undefined ? { n } : {}),
      ...(reason ? { reason } : {}),
    };
  } else if (name === "search" || name === "search_full") {
    const query = searchQueryFromArgs(args);
    tool = query ? { name, query } : { name };
  } else if (name === "archive") {
    const dest = archiveDestFromArgs(args);
    tool = dest
      ? { name, path: dest, wrote: true }
      : { name };
  } else if (PATHLESS_TOOLS.has(name)) {
    tool = { name };
  } else {
    tool = scratchFsTool(campaignRoot, name, args);
  }
  if (toolCallId) tool.callId = toolCallId;
  return tool;
}

function archiveDestFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const rec = args as { slug?: unknown; archive?: unknown };
  if (typeof rec.slug !== "string") return undefined;
  const slug = slugFromArchiveArg(rec.slug);
  if (!slug) return undefined;
  return dossierRel(slug, rec.archive !== false);
}

function searchQueryFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const query = (args as { query?: unknown }).query;
  if (typeof query !== "string") return undefined;
  const trimmed = query.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

function scratchFsTool(
  campaignRoot: string | undefined,
  name: string,
  args: unknown,
): BufferedScratchTool {
  const raw =
    args && typeof args === "object"
      ? extractToolPath(name, args as Record<string, unknown>)
      : "";
  const rel = campaignRoot ? campaignRelPath(campaignRoot, raw) : raw.trim();
  return rel ? { name, path: rel } : { name };
}

function publishedScratchTool(tool: BufferedScratchTool): ScratchTool {
  const out: ScratchTool = { name: tool.name };
  if (tool.path) out.path = tool.path;
  if (tool.wrote) out.wrote = true;
  if (tool.n !== undefined) out.n = tool.n;
  if (tool.value !== undefined) out.value = tool.value;
  if (tool.reason) out.reason = tool.reason;
  if (tool.query) out.query = tool.query;
  return out;
}

function findScratchToolForResult(
  tools: BufferedScratchTool[],
  ev: Extract<AgentSessionEvent, { type: "tool_result" }>,
): BufferedScratchTool | undefined {
  if (ev.toolCallId) {
    return tools.find((t) => t.callId === ev.toolCallId);
  }
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i]!;
    if (tool.name === ev.name && tool.wrote === undefined) return tool;
  }
  return undefined;
}

function campaignRelPath(campaignRoot: string, raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const abs = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(campaignRoot, trimmed);
  const rel = path.relative(campaignRoot, abs).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel;
}

function toolResultFailed(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return (result as { isError?: unknown }).isError === true;
}
