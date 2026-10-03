/**
 * exl3xpu: EXL3 models on Intel Arc (Xe2) GPUs through vLLM, with the ESIMD
 * kernels of github.com/0xSero/exl3xpu, run from NQ's unpacked copy of the
 * project's image (`exl3xpu_image.ts`) in a bubblewrap sandbox. See
 * docs/adr/0009-exl3xpu-engine.md.
 *
 * vLLM is not Atomic's llama-server, so requests are translated on the way
 * (`exl3xpu_wire.ts`): NQ's thinking prefill becomes a chat-template variable,
 * the reasoning budget a per-request field, and "Answer now" is emulated by
 * restarting the stream with the thought closed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isManagedPath } from "../files.ts";
import { templateThinking } from "../gguf.ts";
import type { InstalledModelFile } from "../installation.ts";
import { parseLocalTuning, resolveLocalTuning, type LocalTuning } from "../tuning.ts";
import { forwardAsIs, type Engine } from "./engine.ts";
import {
  EXL3_FAMILIES,
  findExl3Drafter,
  listModelFolders,
  readExl3Model,
  type Exl3Model,
} from "./exl3_model.ts";
import { exl3xpuInstalled, exl3xpuRoot } from "./exl3xpu_image.ts";
import {
  fitExl3MaxTokens,
  streamExl3Completion,
  translateExl3Request,
} from "./exl3xpu_wire.ts";

/**
 * Draft length. With decode graphs on the Arc Pro B70, 2 beat 3 for one game
 * (41.0 vs 36.7 tok/s) and matched it for eight (174 vs 173 tok/s total).
 */
const EXL3_DRAFT_TOKENS = 2;
/**
 * How far before a prompt's end a follow-up turn may diverge and still reuse
 * its sliding-window cache: the reply's opening and NQ's thinking prefill.
 */
const REPLAY_SLACK_TOKENS = 256;

const EXL3XPU_NEEDS_BWRAP =
  "The exl3xpu engine runs in bubblewrap (bwrap), which is not installed. Install it with your package manager (it comes with Flatpak).";

/** exl3xpu takes minutes to compile its graphs on first start. */
const EXL3XPU_START_TIMEOUT_MS = 900_000;

/**
 * How long exl3xpu's startup may go without writing to its log. Its quietest
 * normal phase (compiling a graph) is about a minute; a GPU fault it never
 * recovers from is silent forever.
 */
const EXL3XPU_STALL_MS = 240_000;

// a folder's family and template, read once per host; the proxy asks per request
const models = new Map<string, Promise<Exl3Model | undefined>>();

function cachedExl3Model(directory: string): Promise<Exl3Model | undefined> {
  let model = models.get(directory);
  if (!model) {
    model = readExl3Model(directory);
    models.set(directory, model);
  }
  return model;
}

export const exl3xpuEngine: Engine = {
  name: "exl3xpu",
  label: "exl3xpu",
  logFile: "exl3xpu.log",
  startTimeoutMs: EXL3XPU_START_TIMEOUT_MS,
  stallMs: EXL3XPU_STALL_MS,
  // it runs on the Intel GPU through Level Zero; NQ's sd-cli builds are CUDA
  handsGpuToPainter: false,

  serves: (model) => model.format === "exl3",

  installed: (ctx) => exl3xpuInstalled(ctx.rootDir),

  async verify(ctx) {
    if (!(await exl3xpuInstalled(ctx.rootDir))) {
      throw new Error(
        "The exl3xpu engine is not downloaded. Download it on the load page, or run `nq local install --engine exl3xpu`.",
      );
    }
  },

  /**
   * An EXL3 folder's equivalent of the GGUF header facts: architecture from
   * config.json, sampling from generation_config.json, thinking knobs from its
   * chat template, and base models from the model card's front matter.
   */
  async inspect(model) {
    const exl3 = await readExl3Model(model.primaryPath);
    if (!exl3) return { sharedKvCache: false, sampling: {}, identity: { baseModels: [] } };
    const thinking = exl3.chatTemplate ? templateThinking(exl3.chatTemplate) : undefined;
    return {
      architecture: exl3.architecture,
      sharedKvCache: false,
      sampling: parseLocalTuning(generationTuning(exl3)),
      ...(thinking ? { templateThinking: thinking } : {}),
      identity: {
        name: path.basename(model.primaryPath),
        baseModels: await modelCardBaseModels(model.primaryPath),
      },
    };
  },

  /**
   * vLLM in a bubblewrap sandbox, started from the same profile the load page
   * builds for Atomic. GPU choice, KV offload and flash attention do not
   * apply; exl3xpu always runs on the first Intel GPU with Flash Attention.
   */
  async launch(ctx, _installation, model, opts) {
    const exl3 = await readExl3Model(model.primaryPath);
    if (!exl3) {
      throw new Error(`${model.primaryPath} is no longer an EXL3 model exl3xpu can serve.`);
    }
    const launch = await exl3xpuLaunch({
      rootDir: ctx.rootDir,
      model: exl3,
      alias: model.alias,
      port: opts.port,
      contextTokens: opts.contextTokens,
      cacheK: opts.cacheK,
      cacheV: opts.cacheV,
      sampling: resolveLocalTuning(opts.tuning, generationTuning(exl3)),
      ...(model.drafter ? { drafter: model.drafter.path } : {}),
      parallel: opts.parallel,
      ramCacheGiB: opts.ramCacheGiB,
    });
    opts.onProgress?.({
      stage: "start",
      message: model.drafter
        ? `exl3xpu: drafting with ${model.drafter.name}.`
        : "exl3xpu: no drafter found for this model.",
    });
    return {
      ...launch,
      speculative: model.drafter ? `drafter ${model.drafter.name}` : "off",
      startMessage: `Starting exl3xpu on http://127.0.0.1:${opts.port}; the first start compiles for a few minutes.`,
      spawnError: (error) =>
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(EXL3XPU_NEEDS_BWRAP, { cause: error })
          : undefined,
    };
  },

  async forward(request) {
    const exl3 =
      request.model && request.pathname.endsWith("/chat/completions")
        ? await cachedExl3Model(request.model.primaryPath)
        : undefined;
    const parsed =
      exl3 && typeof request.body === "string" ? parseJsonObject(request.body) : undefined;
    if (!exl3 || !parsed) return forwardAsIs(request);

    const translated = translateExl3Request(parsed, {
      architecture: exl3.architecture,
      reasoningTokens: request.profile.reasoningTokens,
      speculative: request.model?.drafter !== undefined,
    });
    // vLLM serves one model name and refuses any other; llama-server ignores it,
    // so clients (the hosted book sends "qwen") never had to know the alias
    translated.body.model = request.model!.alias;
    translated.body = await fitExl3MaxTokens(request.target.origin, translated.body);
    // exl3xpu has no /control: only a streamed request can end its reasoning early
    if (parsed.stream !== true || request.clientPid === undefined) {
      return forwardAsIs(request, JSON.stringify(translated.body));
    }
    const firstAbort = new AbortController();
    const upstream = await fetch(request.target, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(translated.body),
      signal: AbortSignal.any([request.signal, firstAbort.signal]),
    });
    const init = {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    };
    if (!upstream.ok || !upstream.body) {
      request.release();
      return new Response(upstream.body, init);
    }
    const body = streamExl3Completion({
      target: request.target,
      headers: request.headers,
      body: translated.body,
      architecture: exl3.architecture,
      prefill: translated.prefill ?? "",
      first: upstream,
      signal: request.signal,
      abortFirst: () => firstAbort.abort(),
      onReasoningEnd: (end) => {
        if (end) request.answerNow.offer(end);
        else request.answerNow.withdraw();
      },
      onDone: request.release,
    });
    return new Response(body, init);
  },

  /** EXL3 folders, each paired with a drafter folder built for its backbone when one is there too. */
  async discoverModels(directories, claimAlias, managedModelsRoot) {
    const folders = new Set<string>();
    for (const directory of new Set(directories.map((value) => path.resolve(value)))) {
      for (const folder of await listModelFolders(directory)) folders.add(folder);
    }
    const candidates = [...folders].sort();
    const found = [];
    for (const folder of candidates) {
      const exl3 = await readExl3Model(folder);
      if (!exl3) continue;
      const drafter = await findExl3Drafter(exl3, candidates);
      const entry = (directory: string, size?: number): InstalledModelFile => ({
        name: path.basename(directory),
        path: directory,
        external: !isManagedPath(managedModelsRoot, directory),
        ...(size !== undefined ? { size } : {}),
      });
      found.push({
        alias: claimAlias(path.basename(folder)),
        source: folder,
        files: [entry(folder, exl3.size)],
        primaryPath: folder,
        format: "exl3" as const,
        ...(drafter ? { drafter: entry(drafter) } : {}),
      });
    }
    return found;
  },
};

/** generation_config.json's sampling, under NQ's knob names. */
function generationTuning(exl3: Exl3Model): LocalTuning {
  const g = exl3.generation;
  return {
    ...(g.temperature !== undefined ? { temperature: g.temperature } : {}),
    ...(g.top_k !== undefined ? { topK: g.top_k } : {}),
    ...(g.top_p !== undefined ? { topP: g.top_p } : {}),
    ...(g.min_p !== undefined ? { minP: g.min_p } : {}),
  };
}

/** `base_model:` entries of a model card's YAML front matter, in order. */
async function modelCardBaseModels(directory: string): Promise<string[]> {
  const card = await readFile(path.join(directory, "README.md"), "utf8").catch(() => "");
  const front = /^---\n([\s\S]*?)\n---/.exec(card)?.[1] ?? "";
  const block = /^base_model:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(front)?.[1] ?? "";
  const single = /^base_model:\s*(\S.*)$/m.exec(front)?.[1];
  const names = block
    ? [...block.matchAll(/-\s*(.+)/g)].map((match) => match[1]!.trim())
    : single
      ? [single.trim()]
      : [];
  // "google/gemma-4-31B-it" → "gemma-4-31B-it", as GGUF headers name them
  return names.map((name) => name.split("/").pop()!);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The NQ line appended to a model's chat template: an open thinking prefill. */
const TEMPLATE_PREFILL_HOOK = `
{#- NQ: an open thinking prefill after the generation prompt, from chat_template_kwargs.nq_prefill -#}
{%- if add_generation_prompt and nq_prefill is defined and nq_prefill -%}{{- nq_prefill -}}{%- endif -%}
`;

type Exl3LaunchOptions = {
  rootDir: string;
  model: Exl3Model;
  alias: string;
  port: number;
  contextTokens: number;
  /** f16/bf16 caches stay 16-bit; any quantized choice becomes vLLM's fp8. */
  cacheK: string;
  cacheV: string;
  /** Resolved sampling defaults, llama-server names mapped below. */
  sampling: Record<string, number>;
  drafter?: string;
  /** Requests vLLM runs at once (batched decode); default 1. */
  parallel?: number;
  /** GiB of system RAM that keeps idle requests' KV cache; unset or 0 keeps it on the card only. */
  ramCacheGiB?: number;
};

/**
 * The bubblewrap command that runs vLLM for one model. The sandbox shares the
 * host network (vLLM binds 127.0.0.1 only) and gets its own PID namespace, so
 * stopping bwrap stops every engine process with it.
 */
async function exl3xpuLaunch(
  opts: Exl3LaunchOptions,
): Promise<{ command: string; args: string[] }> {
  const family = EXL3_FAMILIES[opts.model.architecture];
  if (!family) {
    throw new Error(`exl3xpu does not know the ${opts.model.architecture} family.`);
  }
  const root = exl3xpuRoot(opts.rootDir);
  // a missing bwrap surfaces when the runtime spawns it (see EXL3XPU_NEEDS_BWRAP)
  const bwrap = Bun.which("bwrap") ?? "bwrap";
  // the model's template plus NQ's prefill hook, bound read-only into the sandbox
  const templates = path.join(root, "templates");
  await mkdir(templates, { recursive: true });
  const template = path.join(templates, `${opts.alias}.jinja`);
  if (!opts.model.chatTemplate) {
    throw new Error(`${opts.alias} has no chat template for exl3xpu to serve.`);
  }
  await writeFile(template, `${opts.model.chatTemplate}${TEMPLATE_PREFILL_HOOK}`);
  const cache = path.join(root, "cache");
  await mkdir(cache, { recursive: true });

  const draftVocab =
    opts.drafter && family.drafter && family.draftVocab
      ? path.join(import.meta.dir, family.draftVocab)
      : undefined;
  const override = vllmSampling(opts.sampling);
  // vLLM refuses min_p (and logit_bias) with speculative decoding
  if (opts.drafter) delete override.min_p;
  const serve = [
    "/opt/venv/bin/vllm",
    "serve",
    "/nq/model",
    "--served-model-name",
    opts.alias,
    "--host",
    "127.0.0.1",
    "--port",
    String(opts.port),
    "--dtype",
    "bfloat16",
    "--max-model-len",
    String(opts.contextTokens),
    "--max-num-seqs",
    String(Math.max(1, Math.floor(opts.parallel ?? 1))),
    "--max-num-batched-tokens",
    "4096",
    "--gpu-memory-utilization",
    // the drafter and the runtime's own allocations need the rest; 0.95 ran out mid-decode
    "0.90",
    "--kv-cache-dtype",
    vllmCacheType(opts.cacheK, opts.cacheV),
    "--trust-remote-code",
    "--enable-prefix-caching",
    // a request's blocks move to RAM as they are about to leave the card
    // (lazy), and a returning request copies them back instead of recomputing
    ...(opts.ramCacheGiB && opts.ramCacheGiB > 0
      ? [
          "--kv-transfer-config",
          JSON.stringify({
            kv_connector: "SimpleCPUOffloadConnector",
            kv_role: "kv_both",
            kv_connector_extra_config: {
              cpu_bytes_to_use: Math.floor(opts.ramCacheGiB * 2 ** 30),
              lazy_offload: true,
            },
          }),
        ]
      : []),
    // read each shard into RAM first: the Arc's copy engine faulted reading a
    // cold memory-mapped page (xe "Engine memory CAT error", class=bcs), and the
    // engine then spun forever on the reset copy
    "--safetensors-load-strategy",
    "eager",
    "--limit-mm-per-prompt",
    JSON.stringify({ image: 0, video: 0 }),
    // Decode steps replay as captured XPU graphs (one per batch shape: every
    // game count up to `parallel`, each verifying its drafts plus one token);
    // prefill and the drafter run eagerly. Launch overhead dominated eager
    // decode: 1 game 28.9 -> 38.4 tok/s, 19.5k context 9.5 -> 37.8.
    "--compilation-config",
    JSON.stringify({
      cudagraph_mode: "FULL_DECODE_ONLY",
      cudagraph_capture_sizes: captureSizes(
        Math.max(1, Math.floor(opts.parallel ?? 1)),
        opts.drafter && family.drafter ? EXL3_DRAFT_TOKENS + 1 : 1,
      ),
    }),
    // text only, so Flash Attention is safe; the prefix-LM fallback (Triton) is ~30x slower at 12K
    "--attention-backend",
    "FLASH_ATTN",
    "--reasoning-parser",
    family.reasoningParser,
    "--tool-call-parser",
    family.toolParser,
    "--enable-auto-tool-choice",
    "--chat-template",
    "/nq/chat_template.jinja",
    ...(Object.keys(override).length > 0
      ? ["--override-generation-config", JSON.stringify(override)]
      : []),
    ...(opts.drafter && family.drafter
      ? [
          "--speculative-config",
          JSON.stringify({
            method: family.drafter.method,
            model: "/nq/drafter",
            num_speculative_tokens: EXL3_DRAFT_TOKENS,
          }),
        ]
      : []),
  ];
  // The sandbox starts from an empty environment (--clearenv) and gets only
  // this: nothing from the user's shell can switch on vLLM's request or
  // response logging, and its logging stays at the defaults that record no
  // prompt or output text.
  const env: Record<string, string> = {
    PATH: "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
    VIRTUAL_ENV: "/opt/venv",
    HOME: "/tmp",
    XDG_CONFIG_HOME: "/tmp/.config",
    XDG_CACHE_HOME: "/tmp/.cache",
    VLLM_LOGGING_LEVEL: "INFO",
    VLLM_DEBUG_LOG_API_SERVER_RESPONSE: "false",
    VLLM_SERVER_DEV_MODE: "0",
    // no usage reports to stats.vllm.ai
    VLLM_NO_USAGE_STATS: "1",
    DO_NOT_TRACK: "1",
    HF_HUB_OFFLINE: "1",
    // the first Level Zero device; Level Zero lists Intel GPUs only
    ZE_AFFINITY_MASK: "0",
    // Copies from ordinary host memory go through the runtime's staging
    // buffers, not the copy engine reading pages in place: an in-place read of
    // a page the kernel had unmapped or swapped (zram) faulted the Arc's copy
    // engine ("Engine memory CAT error ... class=bcs", engine reset) while
    // loading weights. The fix and both flags come from 0xSero's
    // omarchy-local-ai 6.8.2/6.8.3, seen on the same Arc Pro B70.
    NEOReadDebugKeys: "1",
    TreatNonUsmForTransfersAsSharedSystem: "0",
    EnableSharedSystemUsmSupport: "0",
    VLLM_WORKER_MULTIPROC_METHOD: "spawn",
    VLLM_XPU_ENABLE_XPU_GRAPH: "1",
    VLLM_CACHE_ROOT: "/nq/cache/vllm",
    TORCHINDUCTOR_CACHE_DIR: "/nq/cache/inductor",
    TRITON_CACHE_DIR: "/nq/cache/triton",
    EXL3_INT8_PREFILL: "1",
    ...(opts.model.tiedEmbeddings ? { EXL3_TIED_LM_HEAD: "1" } : {}),
    // Sliding-window layers cache only the tail a follow-up turn can reuse:
    // the end of the prompt, the shared-prefix junction, and the blocks just
    // before the prompt's end where the reply starts (NQ's vLLM fork). Older
    // window blocks are evicted first and never moved to RAM.
    ...(family.slidingWindow
      ? {
          VLLM_PREFIX_CACHE_RETENTION_INTERVAL: "0",
          VLLM_PREFIX_CACHE_REPLAY_SLACK_TOKENS: String(REPLAY_SLACK_TOKENS),
        }
      : {}),
    ...(draftVocab ? { VLLM_GEMMA4_MTP_DRAFT_VOCAB: "/nq/draft_vocab.json" } : {}),
  };
  const args = [
    "--bind",
    path.join(root, "rootfs"),
    "/",
    "--dev-bind",
    "/dev",
    "/dev",
    "--proc",
    "/proc",
    "--ro-bind",
    "/sys",
    "/sys",
    "--tmpfs",
    "/tmp",
    "--unshare-pid",
    "--die-with-parent",
    "--dir",
    "/nq",
    "--ro-bind",
    opts.model.directory,
    "/nq/model",
    "--ro-bind",
    template,
    "/nq/chat_template.jinja",
    "--bind",
    cache,
    "/nq/cache",
    ...(opts.drafter ? ["--ro-bind", opts.drafter, "/nq/drafter"] : []),
    ...(draftVocab ? ["--ro-bind", draftVocab, "/nq/draft_vocab.json"] : []),
    "--clearenv",
    ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]),
    "--chdir",
    "/opt/exl3xpu",
    // a crash must not dump memory holding prompts and replies to disk
    "/bin/sh",
    "-c",
    'ulimit -c 0 && exec "$@"',
    "sh",
    ...serve,
  ];
  return { command: bwrap, args };
}

/**
 * The load page's cache types (Atomic's names) as a vLLM KV cache dtype: any
 * quantized choice is vLLM's fp8, f16 caches stay 16-bit. vLLM's TurboQuant
 * presets (`turboquant_k8v4` etc.) do not start for Gemma 4: its 256- and
 * 512-wide attention layers get TurboQuant pages that do not divide one
 * another, which vLLM 0.26's KV allocator refuses.
 */
function vllmCacheType(cacheK: string, cacheV: string): string {
  const sixteen = (type: string) => ["f16", "bf16", "f32"].includes(type);
  return sixteen(cacheK) && sixteen(cacheV) ? "auto" : "fp8";
}

/** llama-server knob names to vLLM generation-config names. DRY has no vLLM equivalent. */
function vllmSampling(sampling: Record<string, number>): Record<string, number> {
  const names: Record<string, string> = {
    temperature: "temperature",
    topK: "top_k",
    topP: "top_p",
    minP: "min_p",
    repeatPenalty: "repetition_penalty",
    presencePenalty: "presence_penalty",
    frequencyPenalty: "frequency_penalty",
  };
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(sampling)) {
    const name = names[key];
    if (name) out[name] = value;
  }
  return out;
}

/** Batch shapes to capture: 1..games, each verifying `rowsPerGame` tokens per step. */
function captureSizes(games: number, rowsPerGame: number): number[] {
  return Array.from({ length: games }, (_, i) => (i + 1) * rowsPerGame);
}
