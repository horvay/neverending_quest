/**
 * The OMP session's tools and what may run. OMP's built-in `read` / `edit` /
 * `write` are kept; the Game Master's domain tools are registered as custom
 * tools. Two `tool_call` hooks then gate every call: the prompt's tool scope,
 * and the Campaign Sandbox path jail for the file tools.
 */
import { type ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { type } from "@oh-my-pi/pi-ai";
import {
  gmTools,
  type GmToolKnobs,
  type GmToolParameters,
} from "../../play/gm_tools.ts";
import {
  FILE_TOOL_NAMES,
  guardToolCall,
  isFileToolName,
  toolUnavailableMessage,
  type Sandbox,
} from "../../play/sandbox.ts";

/** Built-in FS tools only — custom names must NOT go through OMP normalize (search→grep). */
export const BUILTIN_FS_TOOL_NAMES = FILE_TOOL_NAMES;

/**
 * Extension that blocks stock read/edit/write when the target escapes the
 * Campaign root or hits a protected control-plane path.
 * Exported for tests of the jail decision surface.
 */
export function createSandboxJailExtension(sandbox: Sandbox): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const name = event.toolName;
      if (!isFileToolName(name)) {
        return;
      }
      const input = (
        "input" in event && event.input && typeof event.input === "object"
          ? event.input
          : {}
      ) as Record<string, unknown>;
      const guard = await guardToolCall(sandbox, name, input);
      if (!guard.ok) {
        return { block: true, reason: guard.error };
      }
    });
  };
}

/**
 * Which tools the current prompt may call. The session keeps offering the same
 * tool schemas across passes (they sit at the top of the prompt, so changing
 * them costs the engine its prompt cache); this narrows what actually runs.
 *
 * One scope per OMP session, mutated in place: `adaptOmpSession`'s prompt()
 * narrows `allowed` for a scoped prompt and puts the play set back when it
 * ends. That holds only because the Play Loop serializes prompts on a session.
 */
export type ToolScope = { allowed: ReadonlySet<string> };

export function createToolScopeExtension(scope: ToolScope): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (scope.allowed.has(event.toolName)) return;
      return {
        block: true,
        reason: toolUnavailableMessage(event.toolName, scope.allowed),
      };
    });
  };
}

/**
 * The Game Master's domain tools (src/play/gm_tools.ts) as OMP custom tools.
 * A refused or failed call throws; OMP reports the message to the model.
 */
export function buildCustomTools(sandbox: Sandbox, knobs?: GmToolKnobs) {
  return gmTools(knobs).map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: arkParameters(tool.parameters),
    loadMode: "essential" as const,
    async execute(
      _id: string,
      params: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
      const text = await tool.run(sandbox, params);
      return { content: [{ type: "text", text }] };
    },
  }));
}

/**
 * The same parameters as an ArkType schema, which OMP validates (and coerces)
 * a call's arguments against before it runs.
 */
function arkParameters(parameters: GmToolParameters) {
  const def: Record<string, string> = {};
  for (const [key, schema] of Object.entries(parameters.properties)) {
    def[parameters.required.includes(key) ? key : `${key}?`] = schema.type;
  }
  return type(def as Record<string, "string">);
}
