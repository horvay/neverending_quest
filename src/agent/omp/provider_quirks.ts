/**
 * Fixes to the live OMP model for providers whose catalog entry is wrong for
 * play: xAI grok-4.6 effort, Muse Spark's Responses endpoint, and local GGUFs
 * whose chat template toggles thinking. Applied once, right after the session
 * is created and before its first prompt.
 */
import type { AgentSession as OmpAgentSession } from "@oh-my-pi/pi-coding-agent";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { inspectInstalledLocalModel } from "@nq/local-inference/host.ts";
import { LLAMA_CPP_PROVIDER } from "../llama_cpp.ts";
import type { LocalModelShaping } from "./local_shaping.ts";

/** xAI grok-4.6 accepts reasoning.effort; OMP's allowlist still stops at 4.5. */
const GROK_46_WIRE_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export function isGrok46EffortGap(modelId: string | undefined): boolean {
  return (modelId ?? "").trim().toLowerCase().startsWith("grok-4.6");
}

export type MutableOmpModel = {
  id?: string;
  api?: string;
  baseUrl?: string;
  name?: string;
  provider?: string;
  reasoning?: boolean;
  thinking?: {
    mode?: string;
    efforts?: readonly string[];
    defaultLevel?: string;
    effortMap?: Record<string, string>;
  };
  compat?: {
    omitReasoningEffort?: boolean;
    supportsReasoningEffort?: boolean;
    [key: string]: unknown;
  };
};

/**
 * Muse Spark 1.2 Contributor Free is advertised by OpenCode on
 * `/v1/responses`, while Zen's live model metadata currently reports
 * `openai-completions`. Rebuild the model with the Responses API metadata
 * before the first prompt.
 */
export function isMuseSparkContributorFree(
  modelId: string | undefined,
): boolean {
  return (
    (modelId ?? "").trim().toLowerCase() === "muse-spark-1.2-contributor-free"
  );
}

export function routeMuseSparkContributorFreeThroughResponses(
  model: MutableOmpModel,
): boolean {
  if (!isMuseSparkContributorFree(model.id)) return false;
  if (model.api === "openai-responses") return false;

  const {
    compat: _compat,
    compatConfig: _compatConfig,
    ...spec
  } = model as MutableOmpModel & Record<string, unknown>;
  const routed = buildModel({
    ...spec,
    api: "openai-responses",
  } as unknown as ModelSpec<"openai-responses">);
  Object.assign(model, routed);
  return true;
}

/**
 * OMP omits `reasoning.effort` for grok-4.6, so xAI defaults to high.
 * Patch the live model so our configured level actually hits the wire.
 */
export function enableGrok46ReasoningEffort(model: MutableOmpModel): boolean {
  if (!isGrok46EffortGap(model.id)) return false;
  model.reasoning = true;
  const prior = model.thinking ?? {};
  const efforts = new Set<string>([
    ...(prior.efforts ?? []),
    ...GROK_46_WIRE_EFFORTS,
  ]);
  model.thinking = {
    ...prior,
    mode: "effort",
    efforts: [...efforts],
    effortMap: { minimal: "low", ...prior.effortMap },
  };
  model.compat = {
    ...model.compat,
    omitReasoningEffort: false,
    supportsReasoningEffort: true,
  };
  return true;
}

/**
 * OMP's llama.cpp discovery sends every local model through the Responses API
 * with reasoning off, so neither NQ's thinking prefill (a chat-completions
 * continuation) nor a thinking level reaches the model. OMP reroutes only the
 * ids it knows as Qwen (it misses Bonsai 2's `bonsai-2-27b`), so NQ routes by
 * the GGUF instead: chat completions, with thinking switched through
 * `chat_template_kwargs.enable_thinking`. llama-server also applies that to
 * DeepSeek-V4's template (on = Think High, off = non-think).
 */
export function routeLocalThroughChatTemplate(
  model: MutableOmpModel,
  opts: { preserveThinking?: boolean } = {},
): void {
  const {
    compat: _compat,
    compatConfig,
    ...spec
  } = model as MutableOmpModel & Record<string, unknown>;
  const root = (model.baseUrl ?? "").replace(/\/+$/, "");
  const routed = buildModel({
    ...spec,
    api: "openai-completions",
    baseUrl: root.endsWith("/v1") ? root : `${root}/v1`,
    reasoning: true,
    compat: {
      ...(compatConfig as Record<string, unknown> | undefined),
      supportsReasoningParams: true,
      thinkingFormat: "qwen-chat-template",
      reasoningDisableMode: "qwen-template-false",
      ...(opts.preserveThinking ? { qwenPreserveThinking: true } : {}),
    },
  } as unknown as ModelSpec<"openai-completions">);
  Object.assign(model, routed);
}

/**
 * Applies every quirk that fits the session's model. A local GGUF that needs
 * its chat template also tells `localShaping` what the request hook must send.
 */
export async function fitLiveModel(
  session: OmpAgentSession,
  thinkingLevel: ConfiguredThinkingLevel,
  localShaping: LocalModelShaping,
): Promise<void> {
  // OMP currently discovers Muse Spark Contributor Free as chat completions,
  // but OpenCode serves it on the Responses endpoint.
  try {
    const liveModel = session.model as MutableOmpModel | undefined;
    if (liveModel) {
      routeMuseSparkContributorFreeThroughResponses(liveModel);
      if (enableGrok46ReasoningEffort(liveModel)) {
        session.setThinkingLevel(thinkingLevel);
      }
    }
  } catch {
    // Frozen catalog entry or missing setter — leave OMP defaults.
  }

  const localModel = session.model as MutableOmpModel | undefined;
  const installed =
    localModel?.provider === LLAMA_CPP_PROVIDER && localModel.id
      ? await inspectInstalledLocalModel(localModel.id)
      : undefined;
  const deepseekV4 = installed?.architecture === "deepseek4";
  const templateThinking = installed?.templateThinking;
  if (localModel && (deepseekV4 || templateThinking?.toggle)) {
    routeLocalThroughChatTemplate(localModel, {
      preserveThinking: templateThinking?.preserve,
    });
    localShaping.deepseekV4 = deepseekV4;
    localShaping.reasoningEfforts = templateThinking?.efforts;
    // OMP clamped the level while it took the model for a non-reasoner
    session.setThinkingLevel(thinkingLevel);
  }
}
