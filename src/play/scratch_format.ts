import type { ScratchTool } from "../campaign/types.ts";

export const DEFAULT_LOCAL_THINKING_OPENER =
  "Let me think through the scene step by step:\n1.";

export type LiveScratch = {
  thinking: string;
  tools: ScratchTool[];
};

export function liveScratchOpen(
  live: LiveScratch | undefined,
): live is LiveScratch {
  return Boolean(live && (live.thinking.length > 0 || live.tools.length > 0));
}

/** Late thinking_end snapshot: keep the longer prefix-compatible text, no double. */
export function applyThinkingSnapshot(prior: string, snapshot: string): string {
  if (!snapshot) return prior;
  if (!prior) return snapshot;
  if (snapshot === prior) return prior;
  if (snapshot.startsWith(prior)) return snapshot;
  if (prior.startsWith(snapshot)) return prior;
  return snapshot;
}

export function formatScratchTools(tools: ScratchTool[]): string {
  return tools.map(formatScratchTool).join(" · ");
}

export function formatScratchTool(tool: ScratchTool): string {
  if (tool.name === "roll") {
    if (tool.n !== undefined && tool.value !== undefined) {
      return `roll ${tool.n} → ${tool.value}`;
    }
    if (tool.n !== undefined) return `roll ${tool.n}`;
    return "roll";
  }
  if (tool.query) {
    return `${tool.name} ${tool.query}`;
  }
  if (tool.path) return `${tool.name} ${tool.path}${tool.wrote ? " ✓" : ""}`;
  return tool.name;
}
