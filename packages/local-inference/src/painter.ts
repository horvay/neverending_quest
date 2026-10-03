/**
 * The local painter: Anima through stable-diffusion.cpp's `sd-cli`, run as a
 * child process on this machine. The Play Loop reaches it through its
 * Illustrator port (`localPainter`), or the Local Inference Host runs it
 * between Game Master turns so the GPU is handed over once.
 */
import { access, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export class PainterError extends Error {
  constructor(
    readonly kind: "interrupted" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "PainterError";
  }
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

const DEFAULT_NEGATIVE =
  "worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration, child, loli, teen, mixed hair, swapped outfits";

const MISSING_ANIMA =
  "Put sd-cli, an Anima diffusion GGUF, the Qwen 0.6B encoder, and the Qwen Image VAE in";

export function defaultAnimaDir(): string {
  const override = process.env.NQ_ANIMA_DIR;
  if (override && override.length > 0) return override;
  const xdg = process.env.XDG_DATA_HOME;
  const base =
    xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local/share");
  return path.join(base, "nq", "anima");
}

export type AnimaTools = {
  cli: string;
  diffusion: string;
  llm: string;
  vae: string;
  dir: string;
};

export async function ensureAnimaDir(
  dir: string = defaultAnimaDir(),
): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

function pickDiffusion(names: string[]): string | undefined {
  const ggufs = names.filter((n) => n.endsWith(".gguf") && !/qwen/i.test(n));
  const anima = ggufs.filter((n) => /anima/i.test(n));
  anima.sort((a, b) => a.localeCompare(b));
  ggufs.sort((a, b) => a.localeCompare(b));
  return anima[0] ?? ggufs[0];
}

function pickLlm(names: string[]): string | undefined {
  const cands = names.filter(
    (n) =>
      /\.(safetensors|gguf)$/i.test(n) && /qwen/i.test(n) && !/vae/i.test(n),
  );
  const prefer = cands.filter((n) => /0\.?6b|06b/i.test(n));
  prefer.sort((a, b) => a.localeCompare(b));
  cands.sort((a, b) => a.localeCompare(b));
  return prefer[0] ?? cands[0];
}

function pickVae(names: string[]): string | undefined {
  const cands = names.filter(
    (n) => /vae/i.test(n) && /\.(safetensors|gguf)$/i.test(n),
  );
  cands.sort((a, b) => a.localeCompare(b));
  return cands[0];
}

export async function resolveAnimaTools(
  dir: string = defaultAnimaDir(),
): Promise<AnimaTools | { ready: false; reason: string }> {
  await ensureAnimaDir(dir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isEnoent(err)) {
      return { ready: false, reason: `${MISSING_ANIMA} ${dir}` };
    }
    throw err;
  }
  const cliName = names.find((n) => n === "sd-cli" || n === "sd-cli.exe");
  const diffusionName = pickDiffusion(names);
  const llmName = pickLlm(names);
  const vaeName = pickVae(names);
  if (!cliName || !diffusionName || !llmName || !vaeName) {
    return { ready: false, reason: `${MISSING_ANIMA} ${dir}` };
  }
  const cli = path.join(dir, cliName);
  try {
    await access(cli);
  } catch {
    return { ready: false, reason: `Cannot read ${cli}` };
  }
  return {
    cli,
    diffusion: path.join(dir, diffusionName),
    llm: path.join(dir, llmName),
    vae: path.join(dir, vaeName),
    dir,
  };
}


export async function generateIllustrationPng(opts: {
  tools: AnimaTools;
  prompt: string;
  outPath: string;
  negative?: string;
  seed: number;
  signal?: AbortSignal;
}): Promise<void> {
  await mkdir(path.dirname(opts.outPath), { recursive: true });
  const args = [
    "--diffusion-model",
    opts.tools.diffusion,
    "--llm",
    opts.tools.llm,
    "--vae",
    opts.tools.vae,
    "-p",
    opts.prompt,
    "--negative-prompt",
    opts.negative ?? DEFAULT_NEGATIVE,
    "-o",
    opts.outPath,
    "--steps",
    "8",
    "--cfg-scale",
    "1",
    "-W",
    "1344",
    "-H",
    "768",
    "--sampling-method",
    "euler",
    "--vae-tiling",
    "--offload-to-cpu",
    "-s",
    String(opts.seed),
  ];
  await new Promise<void>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new PainterError("interrupted", "Illustration was interrupted"));
      return;
    }
    const child = spawn(opts.tools.cli, args, {
      // Progress on a piped stdout fills the buffer and deadlocks the child.
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    const onAbort = () => {
      child.kill("SIGTERM");
    };
    opts.signal?.addEventListener("abort", onAbort);
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", (error) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new PainterError("failed", `sd-cli failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) {
        reject(new PainterError("interrupted", "Illustration was interrupted"));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const tail = err.trim().split("\n").slice(-8).join("\n");
      reject(new PainterError("failed", tail || `sd-cli exited ${code ?? "null"}`));
    });
  });
}

export type PaintOneArgs = {
  prompt: string;
  outPath: string;
  seed: number;
  slot: number;
  signal?: AbortSignal;
};

/** The Play Loop's Illustrator, painting each variant with `sd-cli` in-process. */
export function localPainter(opts: { animaDir?: string } = {}): {
  status(): Promise<{ ready: boolean; reason?: string }>;
  paintOne(args: PaintOneArgs): Promise<void>;
} {
  const dir = opts.animaDir ?? defaultAnimaDir();
  return {
    async status() {
      const tools = await resolveAnimaTools(dir);
      return "ready" in tools ? { ready: false, reason: tools.reason } : { ready: true };
    },
    async paintOne(args) {
      const tools = await resolveAnimaTools(dir);
      if ("ready" in tools) throw new PainterError("failed", tools.reason);
      await generateIllustrationPng({ tools, ...args });
    },
  };
}
