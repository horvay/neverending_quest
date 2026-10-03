import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  generateIllustrationPng,
  resolveAnimaTools,
  type AnimaTools,
} from "./painter.ts";
import {
  createLocalRuntimeManager,
  type LocalRuntimeManager,
} from "./runtime.ts";
import {
  localStartOptions,
  normalizeLocalEngineProfile,
  parseLocalEngineProfile,
  sameLocalEngineProfile,
  type LocalEngineProfile,
  type LocalEngineProfileInput,
} from "./profile.ts";

export type LocalInferencePhase =
  | "idle"
  | "starting-game-master"
  | "game-master"
  | "illustrating"
  | "restoring-game-master"
  | "failed";

export type LocalInferenceStatus = {
  phase: LocalInferencePhase;
  gameMasterEndpoint?: string;
  activeProfile?: LocalEngineProfile;
  problem?: string;
};

export type LocalIllustrationCandidate = {
  slot: number;
  seed: number;
  path: string;
};

export type LocalIllustrationRequest = {
  prompt: string;
  seeds: readonly number[];
  /** Where each seed's picture goes, one absolute `.png` path per seed. */
  outPaths: readonly string[];
  signal?: AbortSignal;
  onCandidate?: (candidate: LocalIllustrationCandidate) => void;
};

type PersistedState = {
  schema: 1;
  phase: LocalInferencePhase;
  activeProfile?: LocalEngineProfile;
  problem?: string;
};

type TextWaiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export type LocalInferenceControllerOptions = {
  runtime?: LocalRuntimeManager;
  rootDir?: string;
  enginePort: number;
  animaDir?: string;
  resolveTools?: () => Promise<AnimaTools | { ready: false; reason: string }>;
  paint?: typeof generateIllustrationPng;
};

/**
 * Owns the one-GPU transition between the engine and sd-cli. Callers request
 * capabilities; process stop/start ordering remains inside this module.
 */
export class LocalInferenceController {
  readonly enginePort: number;
  private readonly runtime: LocalRuntimeManager;
  private readonly statePath: string;
  private readonly resolveTools: LocalInferenceControllerOptions["resolveTools"];
  private readonly paint: typeof generateIllustrationPng;
  private state: PersistedState = { schema: 1, phase: "idle" };
  private acceptingText = false;
  private activeTextRequests = 0;
  private readonly textWaiters = new Set<TextWaiter>();
  private readonly idleWaiters = new Set<() => void>();
  private transition: Promise<void> = Promise.resolve();
  private readonly shutdownAbort = new AbortController();
  private closed = false;

  private constructor(opts: LocalInferenceControllerOptions) {
    this.runtime =
      opts.runtime ?? createLocalRuntimeManager({ rootDir: opts.rootDir });
    this.enginePort = opts.enginePort;
    this.statePath = path.join(this.runtime.rootDir, "inference-state.json");
    this.resolveTools =
      opts.resolveTools ?? (() => resolveAnimaTools(opts.animaDir));
    this.paint = opts.paint ?? generateIllustrationPng;
  }

  static async open(
    opts: LocalInferenceControllerOptions,
  ): Promise<LocalInferenceController> {
    const controller = new LocalInferenceController(opts);
    await controller.restore();
    return controller;
  }

  status(publicEndpoint?: string): LocalInferenceStatus {
    return {
      phase: this.state.phase,
      ...(this.state.activeProfile
        ? { activeProfile: { ...this.state.activeProfile } }
        : {}),
      ...(this.state.problem ? { problem: this.state.problem } : {}),
      ...(this.state.activeProfile && publicEndpoint
        ? { gameMasterEndpoint: publicEndpoint }
        : {}),
    };
  }

  /** Projector registered for `alias`, or for the default model when unnamed. */
  private async resolveMmproj(alias?: string): Promise<string | undefined> {
    try {
      // disk only: probing the engine port here would touch whatever listens there
      const installation = await this.runtime.installation();
      const models = installation?.models ?? [];
      const wanted = alias ?? installation?.defaultModel;
      const model = wanted
        ? models.find((candidate) => candidate.alias === wanted)
        : models[0];
      return model?.mmproj?.path;
    } catch {
      return undefined;
    }
  }

  /**
   * The whole profile a request asks for: its fields, defaults for the rest,
   * and the projector registered for its model. The projector is read from the
   * model's registration so that changing it restarts the server.
   */
  async resolveProfile(input: LocalEngineProfileInput = {}): Promise<LocalEngineProfile> {
    const { mmproj: _derived, ...requested } = input;
    const profile = normalizeLocalEngineProfile(requested);
    const mmproj = await this.resolveMmproj(profile.model);
    return mmproj ? { ...profile, mmproj } : profile;
  }

  async activate(
    input: LocalEngineProfileInput = {},
    signal?: AbortSignal,
  ): Promise<LocalInferenceStatus> {
    const normalized = await this.resolveProfile(input);
    await this.exclusive(async () => {
      if (signal?.aborted) throw abortError();
      const previous =
        this.state.phase === "game-master"
          ? this.state.activeProfile
          : undefined;
      this.assertOpen();
      if (
        this.state.phase === "game-master" &&
        this.state.activeProfile &&
        sameLocalEngineProfile(this.state.activeProfile, normalized)
      ) {
        this.setAcceptingText(true);
        return;
      }

      this.setAcceptingText(false);
      await this.waitForTextIdle();
      if (signal?.aborted) {
        if (previous) this.setAcceptingText(true);
        throw abortError();
      }
      await this.writeState({
        schema: 1,
        phase: "starting-game-master",
        activeProfile: normalized,
      });
      try {
        const current = await this.runtime.status({ port: this.enginePort });
        if (current.managed) await this.runtime.stop();
        if (signal?.aborted) throw abortError();
        await this.runtime.start({
          port: this.enginePort,
          ...localStartOptions(normalized),
          ...(signal ? { signal } : {}),
        });
        await this.writeState({
          schema: 1,
          phase: "game-master",
          activeProfile: normalized,
        });
        this.setAcceptingText(true);
      } catch (error) {
        if (isAbortError(error)) {
          if (previous) {
            try {
              await this.runtime.start({
                port: this.enginePort,
                ...localStartOptions(previous),
              });
              await this.writeState({
                schema: 1,
                phase: "game-master",
                activeProfile: previous,
              });
              this.setAcceptingText(true);
            } catch (restoreError) {
              await this.writeState({
                schema: 1,
                phase: "failed",
                activeProfile: previous,
                problem: errorMessage(restoreError),
              });
              throw new AggregateError(
                [error, restoreError],
                "Local model startup was cancelled and the prior Game Master could not be restored.",
              );
            }
          } else {
            await this.writeState({ schema: 1, phase: "idle" });
            this.rejectTextWaiters(
              new Error("No local Game Master is active."),
            );
          }
          throw error;
        }
        const message = errorMessage(error);
        await this.writeState({
          schema: 1,
          phase: "failed",
          activeProfile: normalized,
          problem: message,
        });
        throw error;
      }
    });
    return this.status();
  }

  async deactivate(): Promise<void> {
    await this.exclusive(async () => {
      this.assertOpen();
      this.setAcceptingText(false);
      await this.waitForTextIdle();
      await this.runtime.stop();
      await this.writeState({ schema: 1, phase: "idle" });
      this.rejectTextWaiters(new Error("No local Game Master is active."));
    });
  }

  async illustrate(
    request: LocalIllustrationRequest,
  ): Promise<readonly LocalIllustrationCandidate[]> {
    let candidates: readonly LocalIllustrationCandidate[] = [];
    await this.exclusive(async () => {
      const signal = request.signal
        ? AbortSignal.any([request.signal, this.shutdownAbort.signal])
        : this.shutdownAbort.signal;
      this.assertOpen();
      if (signal.aborted) throw abortError();
      if (request.seeds.length === 0) {
        throw new Error("Illustration requires at least one seed.");
      }
      if (request.outPaths.length !== request.seeds.length) {
        throw new Error("Illustration needs one output path per seed.");
      }

      const tools = await this.resolveTools!();
      if ("ready" in tools && tools.ready === false)
        throw new Error(tools.reason);
      const profile = this.state.activeProfile;
      if (profile && !(await this.handsGpuToPainter(profile))) {
        candidates = await this.paintAll(request, tools, signal);
        return;
      }
      this.setAcceptingText(false);
      await this.waitForTextIdle();
      await this.writeState({
        schema: 1,
        phase: "illustrating",
        ...(profile ? { activeProfile: profile } : {}),
      });

      let illustrationError: unknown;
      const completed: LocalIllustrationCandidate[] = [];
      try {
        if (profile) await this.runtime.stop();
        for (let slot = 0; slot < request.seeds.length; slot++) {
          if (signal.aborted) throw abortError();
          const seed = request.seeds[slot]!;
          const outPath = request.outPaths[slot]!;
          await this.paint({
            tools: requireAnimaTools(tools),
            prompt: request.prompt,
            outPath,
            seed,
            signal,
          });
          const candidate = { slot, seed, path: outPath };
          completed.push(candidate);
          request.onCandidate?.(candidate);
        }
        candidates = completed;
      } catch (error) {
        illustrationError = error;
      }

      let restoreError: unknown;
      if (profile) {
        try {
          await this.writeState({
            schema: 1,
            phase: "restoring-game-master",
            activeProfile: profile,
          });
          await this.runtime.start({
            port: this.enginePort,
            ...localStartOptions(profile),
          });
          await this.writeState({
            schema: 1,
            phase: "game-master",
            activeProfile: profile,
          });
          this.setAcceptingText(true);
        } catch (error) {
          restoreError = error;
          await this.writeState({
            schema: 1,
            phase: "failed",
            activeProfile: profile,
            problem: errorMessage(error),
          });
        }
      } else {
        await this.writeState({ schema: 1, phase: "idle" });
        this.rejectTextWaiters(new Error("No local Game Master is active."));
      }

      if (illustrationError && restoreError) {
        throw new AggregateError(
          [illustrationError, restoreError],
          "Illustration failed and the local Game Master could not be restored.",
        );
      }
      if (restoreError) {
        throw new Error(
          `The Illustration finished, but the local Game Master could not be restored: ${errorMessage(restoreError)}`,
          { cause: restoreError },
        );
      }
      if (illustrationError) throw illustrationError;
    });
    return candidates;
  }

  /**
   * Whether the Game Master's engine must give its GPU to the painter. An
   * engine on another card than NQ's sd-cli builds keeps serving text while
   * the Illustration paints; when unsure, the GPU is handed over.
   */
  private async handsGpuToPainter(profile: LocalEngineProfile): Promise<boolean> {
    try {
      return (await this.runtime.servingEngine(profile.model)).engine.handsGpuToPainter;
    } catch {
      return true;
    }
  }

  /** Paints every seed while the Game Master keeps serving text. */
  private async paintAll(
    request: LocalIllustrationRequest,
    tools: AnimaTools | { ready: false; reason: string },
    signal: AbortSignal,
  ): Promise<LocalIllustrationCandidate[]> {
    const completed: LocalIllustrationCandidate[] = [];
    for (let slot = 0; slot < request.seeds.length; slot++) {
      if (signal.aborted) throw abortError();
      const seed = request.seeds[slot]!;
      const outPath = request.outPaths[slot]!;
      await this.paint({ tools: requireAnimaTools(tools), prompt: request.prompt, outPath, seed, signal });
      const candidate = { slot, seed, path: outPath };
      completed.push(candidate);
      request.onCandidate?.(candidate);
    }
    return completed;
  }

  async acquireTextRequest(signal?: AbortSignal): Promise<() => void> {
    this.assertOpen();
    if (this.acceptingText) return this.beginTextRequest();
    if (!this.state.activeProfile) {
      throw new Error("No local Game Master is active.");
    }
    if (signal?.aborted) throw abortError();

    return new Promise<() => void>((resolve, reject) => {
      const waiter: TextWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.textWaiters.delete(waiter);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.textWaiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.shutdownAbort.abort();
    this.setAcceptingText(false);
    this.rejectTextWaiters(new Error("Local inference host is stopping."));
    await this.transition.catch(() => undefined);
    await this.waitForTextIdle();
    await this.runtime.stop();
    await this.writeState({ schema: 1, phase: "idle" });
  }

  private async restore(): Promise<void> {
    await mkdir(this.runtime.rootDir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
      this.state = parseState(raw);
    } catch {
      this.state = { schema: 1, phase: "idle" };
    }

    const runtime = await this.runtime.status({ port: this.enginePort });
    const profile = this.state.activeProfile;
    if (runtime.managed && profile) {
      await this.writeState({
        schema: 1,
        phase: "game-master",
        activeProfile: profile,
      });
      this.setAcceptingText(true);
      return;
    }
    if (runtime.managed && !profile) await this.runtime.stop();
    if (profile && this.state.phase !== "idle") {
      try {
        await this.runtime.start({
          port: this.enginePort,
          ...localStartOptions(profile),
        });
        await this.writeState({
          schema: 1,
          phase: "game-master",
          activeProfile: profile,
        });
        this.setAcceptingText(true);
        return;
      } catch (error) {
        await this.writeState({
          schema: 1,
          phase: "failed",
          activeProfile: profile,
          problem: errorMessage(error),
        });
        return;
      }
    }
    await this.writeState({ schema: 1, phase: "idle" });
  }

  private exclusive(work: () => Promise<void>): Promise<void> {
    const run = this.transition.then(work, work);
    this.transition = run.catch(() => undefined);
    return run;
  }

  private beginTextRequest(): () => void {
    this.activeTextRequests++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeTextRequests--;
      if (this.activeTextRequests === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    };
  }

  private waitForTextIdle(): Promise<void> {
    if (this.activeTextRequests === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private setAcceptingText(accepting: boolean): void {
    this.acceptingText = accepting;
    if (!accepting) return;
    for (const waiter of this.textWaiters) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      waiter.resolve(this.beginTextRequest());
    }
    this.textWaiters.clear();
  }

  private rejectTextWaiters(error: Error): void {
    for (const waiter of this.textWaiters) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      waiter.reject(error);
    }
    this.textWaiters.clear();
  }

  private async writeState(state: PersistedState): Promise<void> {
    this.state = state;
    await writeFile(
      this.statePath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Local inference host is closed.");
  }
}

export async function clearLocalInferenceState(rootDir: string): Promise<void> {
  await rm(path.join(rootDir, "inference-state.json"), { force: true });
}

function parseState(value: unknown): PersistedState {
  if (!value || typeof value !== "object") return { schema: 1, phase: "idle" };
  const raw = value as Record<string, unknown>;
  const phases: readonly LocalInferencePhase[] = [
    "idle",
    "starting-game-master",
    "game-master",
    "illustrating",
    "restoring-game-master",
    "failed",
  ];
  const phase = phases.includes(raw.phase as LocalInferencePhase)
    ? (raw.phase as LocalInferencePhase)
    : "idle";
  const parsed = parseLocalEngineProfile(raw.activeProfile);
  // a profile without its sizes is not one this host wrote
  const activeProfile =
    parsed.contextTokens !== undefined && parsed.reasoningTokens !== undefined
      ? normalizeLocalEngineProfile(parsed)
      : undefined;
  return {
    schema: 1,
    phase,
    ...(activeProfile ? { activeProfile } : {}),
    ...(typeof raw.problem === "string" ? { problem: raw.problem } : {}),
  };
}

function requireAnimaTools(
  tools: AnimaTools | { ready: false; reason: string },
): AnimaTools {
  if ("ready" in tools) throw new Error(tools.reason);
  return tools;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  return Object.assign(new Error("Local inference request was cancelled."), {
    name: "AbortError",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
