/**
 * An engine is a program that serves a local model over an OpenAI-compatible
 * HTTP API: Atomic (llama.cpp's `llama-server`) for GGUF files, exl3xpu (vLLM
 * on Intel Arc) for EXL3 folders. The runtime manager, the Local Inference
 * Host and the inference controller treat every engine alike through this
 * interface; what differs between them lives in its implementation under
 * `engines/`. `registry.ts` picks the engine for a model.
 */
import type { ModelEngineInspection } from "../gguf.ts";
import type {
  InstalledLocalModel,
  LocalInstallation,
  LocalProgress,
} from "../installation.ts";
import type { LocalFetch } from "../model_source.ts";
import type { CommandRunner } from "../process.ts";
import type { LocalEngineProfile, LocalStartProfile } from "../profile.ts";

export type EngineName = "atomic" | "exl3xpu";

/** What an engine may use from the runtime manager that runs it. */
export type EngineContext = {
  rootDir: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch: LocalFetch;
  runCommand: CommandRunner;
};

/** The profile one launch starts with, its port chosen and its sizes checked. */
export type EngineLaunchOptions = LocalStartProfile & {
  port: number;
  onProgress?: (progress: LocalProgress) => void;
};

/** How to start the engine for one model; the manager spawns and watches it. */
export type EngineLaunch = {
  command: string;
  args: string[];
  /** Speculative decoding as status reports it: "off", "embedded (…)", "drafter …". */
  speculative: string;
  /** Shown as the process starts. */
  startMessage: string;
  /** Explains a failed spawn in the player's terms, when the engine knows why. */
  spawnError?: (error: unknown) => Error | undefined;
};

export type ReasoningEndResult = { success: boolean; message?: string };

/** Ends the Game Master's thinking now, so it answers with what it has. */
export type ReasoningEnd = () => Promise<ReasoningEndResult>;

/**
 * Where a request offers its "Answer now" to the client that sent it. An
 * engine offers one while the request is still thinking and withdraws it once
 * the answer has begun or the request has ended; a withdrawal never removes
 * a newer request's offer.
 */
export type AnswerNowSlot = {
  offer(end: ReasoningEnd): void;
  withdraw(): void;
};

/** One text request the Local Inference Host forwards to the engine. */
export type EngineTextRequest = {
  method: string;
  /** The path the client asked for, e.g. `/v1/chat/completions`. */
  pathname: string;
  /** That path (and query) on the engine. */
  target: URL;
  headers: Headers;
  body?: BodyInit;
  signal: AbortSignal;
  /** The leased client that sent a completion, which may cut it short. */
  clientPid?: number;
  /** The model the engine serves; unknown when it left the catalog since. */
  model?: InstalledLocalModel;
  profile: LocalEngineProfile;
  answerNow: AnswerNowSlot;
  /** Gives the host's text slot back; call it once the response is over. */
  release: () => void;
};

export interface Engine {
  readonly name: EngineName;
  /** The engine's name in messages. */
  readonly label: string;
  /** Its log, under `<root>/logs/`. */
  readonly logFile: string;
  /** How long a start may take before it is given up. */
  readonly startTimeoutMs: number;
  /** A start whose log does not grow for this long is hung; unset never checks. */
  readonly stallMs?: number;
  /**
   * The painter (sd-cli) needs this engine's GPU, so an Illustration stops
   * the engine and starts it again after. False when they run on different
   * cards.
   */
  readonly handsGpuToPainter: boolean;
  /** Whether this engine is the one that serves `model`. */
  serves(model: InstalledLocalModel): boolean;
  /** Whether the engine itself is on disk, ready to launch. */
  installed(ctx: EngineContext, installation?: LocalInstallation): Promise<boolean>;
  /** Fails with what the player can do when `model` cannot launch here now. */
  verify(
    ctx: EngineContext,
    installation: LocalInstallation,
    model: InstalledLocalModel,
  ): Promise<void>;
  /** What the model says about itself: architecture, sampling, template knobs, identity. */
  inspect(model: InstalledLocalModel): Promise<ModelEngineInspection>;
  /** The command that serves `model` with this profile. */
  launch(
    ctx: EngineContext,
    installation: LocalInstallation,
    model: InstalledLocalModel,
    opts: EngineLaunchOptions,
  ): Promise<EngineLaunch>;
  /**
   * Forwards one text request, translated into the engine's dialect where it
   * differs from Atomic's, and offers "Answer now" while it thinks.
   */
  forward(request: EngineTextRequest): Promise<Response>;
  /**
   * Models of this engine's own format found in the model directories, for a
   * format the GGUF scan does not see. `claimAlias` hands out unique aliases.
   */
  discoverModels?(
    directories: readonly string[],
    claimAlias: (name: string) => string,
    managedModelsRoot: string,
  ): Promise<InstalledLocalModel[]>;
}

/** Sends a request to the engine as it is, and relays the reply. */
export async function forwardAsIs(
  request: EngineTextRequest,
  body: BodyInit | undefined = request.body,
): Promise<Response> {
  const upstream = await fetch(request.target, {
    method: request.method,
    headers: request.headers,
    ...(body === undefined ? {} : { body }),
    signal: request.signal,
  });
  return relay(upstream, { onEnd: request.release });
}

/**
 * Streams the engine's reply back to the client. `onChunk` sees each chunk on
 * its way through; `onEnd` runs once, when the body ends, fails or is
 * cancelled (or at once when there is no body).
 */
export function relay(
  upstream: Response,
  hooks: { onChunk?: (chunk: Uint8Array) => void; onEnd: () => void },
): Response {
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    hooks.onEnd();
  };
  const init = {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  };
  if (!upstream.body) {
    end();
    return new Response(null, init);
  }
  const reader = upstream.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          end();
          controller.close();
        } else {
          hooks.onChunk?.(next.value);
          controller.enqueue(next.value);
        }
      } catch (error) {
        end();
        controller.error(error);
      }
    },
    async cancel(reason) {
      end();
      await reader.cancel(reason);
    },
  });
  return new Response(body, init);
}

export function parseReasoningEndResult(raw: unknown): ReasoningEndResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "Local inference returned an invalid reasoning control response.",
    );
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.success !== "boolean") {
    throw new Error(
      "Local inference returned an invalid reasoning control response.",
    );
  }
  return {
    success: body.success,
    ...(typeof body.message === "string" && body.message
      ? { message: body.message }
      : {}),
  };
}
