/**
 * Atomic: AtomicBot's llama.cpp fork (`llama-server`), which serves GGUF
 * models on whichever card its build reaches. NQ's Game Master speaks its
 * dialect natively, so requests pass through unchanged; "Answer now" is its
 * `/control` endpoint, which ends a reasoning block in place.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../files.ts";
import {
  inspectModelEngine,
  inspectModelMtp,
  type ModelEngineInspection,
} from "../gguf.ts";
import type { InstalledLocalModel } from "../installation.ts";
import { modelQuirks } from "../quirks.ts";
import { localTuningArgs, localTuningField } from "../tuning.ts";
import { resolveAtomicGpu } from "./atomic_builds.ts";
import {
  parseReasoningEndResult,
  relay,
  type AnswerNowSlot,
  type Engine,
  type EngineLaunchOptions,
} from "./engine.ts";

/**
 * Hybrid models (Qwen3.5 and similar) save ~150 MiB of recurrent state per
 * checkpoint. Atomic's default of 32 makes a long campaign's cached prompt
 * larger than the 8 GiB prompt cache, so a side request that borrows the slot
 * drops the Game Master's prompt and the next turn re-prefills it.
 */
const LOCAL_CONTEXT_CHECKPOINTS = 16;

// headers only change when the file does; the Home asks on every snapshot
const inspections = new Map<
  string,
  { stamp: string; inspection: ModelEngineInspection }
>();

export const atomicEngine: Engine = {
  name: "atomic",
  label: "Atomic",
  logFile: "llama-server.log",
  startTimeoutMs: 180_000,
  // NQ's sd-cli builds share the card Atomic loads onto
  handsGpuToPainter: true,

  serves: (model) => model.format === undefined,

  async installed(_ctx, installation) {
    return installation !== undefined && fileExists(installation.runtime.serverPath);
  },

  async verify(ctx, installation, model) {
    if (!(await this.installed(ctx, installation))) {
      throw new Error(
        "The installed Atomic server is missing. Run `nq local install` again.",
      );
    }
    for (const file of model.files) {
      if (!(await fileExists(file.path))) {
        throw new Error(`Installed model file is missing: ${file.path}`);
      }
    }
    if (model.mtp && !(await fileExists(model.mtp.path))) {
      throw new Error(`Installed MTP model file is missing: ${model.mtp.path}`);
    }
  },

  async inspect(model) {
    const file = model.primaryPath;
    const info = await stat(file).catch(() => undefined);
    if (!info) return { sharedKvCache: false, sampling: {}, identity: { baseModels: [] } };
    const stamp = `${info.size}:${info.mtimeMs}`;
    const cached = inspections.get(file);
    if (cached?.stamp === stamp) return cached.inspection;
    const inspection = await inspectModelEngine(file);
    inspections.set(file, { stamp, inspection });
    return inspection;
  },

  async launch(ctx, installation, model, opts) {
    const header = await inspectModelEngine(model.primaryPath);
    const quirks = modelQuirks(header.architecture);
    const { cacheK, cacheV } = cacheTypes(opts, header.sharedKvCache, quirks.kvCacheType);
    const fitTarget = opts.tuning.fitTarget ?? localTuningField("fitTarget").fallback;
    const tuning =
      quirks.fitTargetMiB !== undefined
        ? { ...opts.tuning, fitTarget: quirks.fitTargetMiB }
        : quirks.minFitTargetMiB !== undefined
          ? { ...opts.tuning, fitTarget: Math.max(fitTarget, quirks.minFitTargetMiB) }
          : opts.tuning;

    const args = [
      "-m",
      model.primaryPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(opts.port),
      "-np",
      "1",
      "-c",
      String(opts.contextTokens),
      "-fa",
      opts.flashAttention ? "on" : "off",
      "-ctk",
      cacheK,
      "-ctv",
      cacheV,
      "--fit",
      "on",
      "--ctx-checkpoints",
      String(LOCAL_CONTEXT_CHECKPOINTS),
      "--jinja",
      "-a",
      model.alias,
      "--reasoning-budget",
      String(opts.reasoningTokens),
      ...localTuningArgs(tuning, header.sampling),
    ];
    if (!opts.kvOffload) args.push("--no-kv-offload");
    const gpu = await resolveAtomicGpu(ctx, installation, opts.gpu);
    args.push(...gpu.args);
    if (model.mmproj) {
      if (!(await fileExists(model.mmproj.path))) {
        throw new Error(
          `Projector file is missing: ${model.mmproj.path}. ` +
            `Re-select it with \`nq local mmproj ${model.alias} <file>\`, or clear it with --none.`,
        );
      }
      args.push("--mmproj", model.mmproj.path);
    }

    const speculative = await resolveSpeculative(model);
    opts.onProgress?.({ stage: "start", message: speculative.message });
    args.push(...speculative.args);
    // The draft's KV cache defaults to f16 whatever -ctk/-ctv say.
    if (speculative.args.length > 0) {
      args.push("-ctkd", cacheK, "-ctvd", cacheV);
    }
    return {
      command: gpu.serverPath,
      args,
      speculative: speculative.summary,
      startMessage: `Starting Atomic on http://127.0.0.1:${opts.port}.`,
    };
  },

  async forward(request) {
    const upstream = await fetch(request.target, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: request.signal,
    });
    // only a leased client's completion can be cut short
    const completion =
      request.clientPid === undefined
        ? undefined
        : trackCompletion(
            `${request.target.origin}${request.pathname}/control`,
            request.answerNow,
          );
    return relay(upstream, {
      ...(completion ? { onChunk: completion.push } : {}),
      onEnd: () => {
        completion?.finish();
        request.release();
      },
    });
  },
};

/**
 * The caches Atomic runs with. A quantized V cache needs flash attention, and
 * a quantized K cache is several times slower without it, so both go to f16
 * then; a model with one KV cache takes K's type for both.
 */
function cacheTypes(
  opts: EngineLaunchOptions,
  sharedKvCache: boolean,
  forced: string | undefined,
): { cacheK: string; cacheV: string } {
  if (forced) return { cacheK: forced, cacheV: forced };
  if (!opts.flashAttention) {
    opts.onProgress?.({
      stage: "start",
      message: "Flash attention off: using f16 for both caches.",
    });
    return { cacheK: "f16", cacheV: "f16" };
  }
  if (opts.cacheV !== opts.cacheK && sharedKvCache) {
    opts.onProgress?.({
      stage: "start",
      message: `This model keeps K and V in one cache; using ${opts.cacheK} for both.`,
    });
    return { cacheK: opts.cacheK, cacheV: opts.cacheK };
  }
  return { cacheK: opts.cacheK, cacheV: opts.cacheV };
}

/**
 * Decide speculative decoding from GGUF headers, never from filenames.
 * A registered draft file must carry NextN layers; otherwise the primary
 * model's own header decides whether Atomic gets `draft-mtp`.
 */
async function resolveSpeculative(
  model: InstalledLocalModel,
): Promise<{ args: string[]; summary: string; message: string }> {
  if (model.mtp) {
    const draft = await inspectModelMtp(model.mtp.path);
    if (!draft.supported) {
      throw new Error(
        `Registered MTP file has no multi-token-prediction layers: ${model.mtp.path} (${draft.detail}). ` +
          "Reinstall with a NextN draft GGUF, or without --mtp.",
      );
    }
    const name = path.basename(model.mtp.path);
    return {
      args: [
        "-md",
        model.mtp.path,
        "--spec-type",
        "nextn",
        "--spec-draft-n-max",
        "2",
        "--spec-draft-n-min",
        "1",
      ],
      summary: `nextn draft ${name}`,
      message: `MTP on: draft file ${name} (${draft.detail}).`,
    };
  }
  const primary = await inspectModelMtp(model.primaryPath);
  if (!primary.supported) {
    return {
      args: [],
      summary: "off",
      message: `MTP off: ${primary.detail}.`,
    };
  }
  return {
    args: [
      "--spec-type",
      "draft-mtp",
      "--spec-draft-n-max",
      String(modelQuirks(primary.architecture).mtpDraftTokens ?? 2),
      "--spec-draft-n-min",
      "1",
    ],
    summary: `embedded (${primary.detail})`,
    message: `MTP on: ${primary.detail}.`,
  };
}

/**
 * Watches a streamed completion for its id, and offers "Answer now" for it:
 * Atomic's `/control` with that id and `reasoning_end`.
 */
function trackCompletion(
  controlUrl: string,
  answerNow: AnswerNowSlot,
): {
  push: (chunk: Uint8Array) => void;
  finish: () => void;
} {
  const decoder = new TextDecoder();
  let buffered = "";
  let completionId: string | undefined;
  const acceptLine = (line: string) => {
    const id = parseCompletionId(line);
    if (!id || id === completionId) return;
    completionId = id;
    answerNow.offer(async () => {
      const response = await fetch(controlUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action: "reasoning_end" }),
      });
      const result = parseReasoningEndResult(await response.json());
      if (!response.ok) {
        throw new Error(
          result.message ||
            `Atomic returned HTTP ${response.status} while ending reasoning.`,
        );
      }
      return result;
    });
  };
  const drain = () => {
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      acceptLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
  };
  return {
    push(chunk) {
      buffered += decoder.decode(chunk, { stream: true });
      drain();
    },
    finish() {
      buffered += decoder.decode();
      drain();
      if (buffered) acceptLine(buffered);
      buffered = "";
      answerNow.withdraw();
    },
  };
}

function parseCompletionId(line: string): string | undefined {
  const payload = line.trim().replace(/^data:\s*/, "");
  if (!payload || payload === "[DONE]") return undefined;
  try {
    const raw: unknown = JSON.parse(payload);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const body = raw as Record<string, unknown>;
    const direct = body.id;
    if (typeof direct === "string" && direct) return direct;
    const response = body.response;
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return undefined;
    }
    const nested = (response as Record<string, unknown>).id;
    return typeof nested === "string" && nested ? nested : undefined;
  } catch {
    return undefined;
  }
}
