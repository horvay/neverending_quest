import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeLocalEngineProfile,
  type LocalGpuList,
  type LocalStartProfile,
} from "./profile.ts";
import {
  inspectModelSource,
  resolveModelSource,
  type ModelInspection,
  type LocalFetch,
  type ModelRole,
} from "./model_source.ts";
import {
  detectHardwareFacts,
  selectLocalRuntimeTarget,
  type HardwareFacts,
  type LocalBackend,
} from "./target.ts";
import {
  errorMessage,
  fileExists,
  fileSizeOrZero,
  isManagedPath,
  readLogSince,
} from "./files.ts";
import type { Engine, EngineContext } from "./engines/engine.ts";
import {
  engineForModel,
  engineNamed,
  recordedEngineName,
} from "./engines/registry.ts";
import { exl3xpuEngine } from "./engines/exl3xpu.ts";
import { installExl3xpuEngine } from "./engines/exl3xpu_image.ts";
import {
  clearRunRecord,
  readInstallationRecord,
  readRunRecord,
  writeInstallationRecord,
  writeRunRecord,
  type InstalledLocalModel,
  type InstalledModelFile,
  type LocalInstallation,
  type LocalProgress,
  type RunRecord,
} from "./installation.ts";
import {
  isMmprojFile,
  listMmprojFiles,
  normalizeAlias,
  refreshModelCatalog,
} from "./catalog.ts";
import { downloadVerified, installModelFiles } from "./download.ts";
import {
  defaultFindManagedPids,
  defaultIsPidAlive,
  defaultOwnsPid,
  runCommand,
  spawnDetachedServer,
  terminateProcess,
  type CommandRunner,
  type FindManagedPids,
  type OwnsPid,
  type SpawnServer,
} from "./process.ts";
import {
  downloadAtomicBuild,
  downloadSideBuild,
  installedAtomicBuilds,
  listAtomicGpus,
  DEFAULT_ATOMIC_RELEASE,
} from "./engines/atomic_builds.ts";

export { DEFAULT_ATOMIC_RELEASE };
// the manager's own records, re-exported with the API that returns them
export type {
  InstalledLocalModel,
  InstalledModelFile,
  LocalInstallation,
  LocalProgress,
} from "./installation.ts";
export const DEFAULT_LOCAL_MODEL_PORT = 8080;

export type ModelInstallRequest = {
  source: string;
  file?: string;
  sha256?: string;
  hfToken?: string;
};

export type InstallLocalRuntimeOptions = {
  backend?: LocalBackend;
  release?: string;
  model?: ModelInstallRequest;
  mtp?: ModelInstallRequest;
  alias?: string;
  onProgress?: (progress: LocalProgress) => void;
};

export type StartLocalRuntimeOptions = Partial<LocalStartProfile> & {
  port?: number;
  /** installed model alias; unset starts the installation's default model */
  model?: string;
  onProgress?: (progress: LocalProgress) => void;
  signal?: AbortSignal;
};

export type DownloadedModel = {
  source: string;
  label: string;
  files: InstalledModelFile[];
};

export type LocalRuntimeStatus = {
  state:
    | "not-installed"
    | "stopped"
    | "starting"
    | "running"
    | "external"
    | "unhealthy";
  endpoint: string;
  installed: boolean;
  managed: boolean;
  models: string[];
  pid?: number;
  installation?: LocalInstallation;
  problem?: string;
  /** Speculative decoding profile of the managed run, e.g. "off" or "embedded (...)". */
  speculative?: string;
};

export type LocalRuntimeManager = {
  readonly rootDir: string;
  inspectModel(
    source: string,
    opts?: { role?: ModelRole; file?: string; hfToken?: string },
  ): Promise<ModelInspection>;
  downloadModel(
    request: ModelInstallRequest,
    opts?: { role?: ModelRole; onProgress?: (progress: LocalProgress) => void },
  ): Promise<DownloadedModel>;
  install(opts?: InstallLocalRuntimeOptions): Promise<LocalInstallation>;
  /** Every card the downloaded Atomic builds can run on. */
  listGpus(): Promise<LocalGpuList>;
  /**
   * Downloads another Atomic build beside the installed one, for a card the
   * installed build cannot reach. The running engine is left alone.
   */
  installEngine(
    backend: Exclude<LocalBackend, "auto">,
    opts?: { onProgress?: (progress: LocalProgress) => void },
  ): Promise<void>;
  /** Downloads and unpacks the exl3xpu engine that serves EXL3 models. */
  installExl3xpu(opts?: {
    onProgress?: (progress: LocalProgress) => void;
  }): Promise<void>;
  /** Whether the exl3xpu engine is unpacked and ready to serve EXL3 models. */
  exl3xpuInstalled(): Promise<boolean>;
  /**
   * The engine that serves an installed model (the default model when
   * unnamed), with the model; Atomic when the model is not installed. Reads
   * disk only.
   */
  servingEngine(
    alias?: string,
  ): Promise<{ engine: Engine; model?: InstalledLocalModel }>;
  /** Every *mmproj*.gguf found in the model directories, for a projector picker. */
  listMmproj(): Promise<InstalledModelFile[]>;
  /** Attaches a projector to a model, or clears it when `file` is undefined. */
  setModelMmproj(alias: string, file?: string): Promise<LocalInstallation>;
  start(opts?: StartLocalRuntimeOptions): Promise<LocalRuntimeStatus>;
  status(opts?: { port?: number }): Promise<LocalRuntimeStatus>;
  /** The installed runtime and models from disk, without probing any endpoint. */
  installation(): Promise<LocalInstallation | undefined>;
  stop(): Promise<LocalRuntimeStatus>;
  uninstall(): Promise<void>;
};

export type LocalRuntimeManagerOptions = {
  rootDir?: string;
  modelsDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: LocalFetch;
  hardware?: HardwareFacts | (() => Promise<HardwareFacts>);
  runCommand?: CommandRunner;
  spawnServer?: SpawnServer;
  isPidAlive?: (pid: number) => boolean;
  ownsPid?: OwnsPid;
  findManagedPids?: FindManagedPids;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  /**
   * A start whose log does not grow for this long is treated as hung, for the
   * engines that check (exl3xpu); each engine has its own default.
   */
  startupStallMs?: number;
};

export function defaultLocalRuntimeDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, "nq", "local");
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Neverending Quest", "local");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Neverending Quest",
      "local",
    );
  }
  return path.join(os.homedir(), ".local", "share", "nq", "local");
}

export function createLocalRuntimeManager(
  opts: LocalRuntimeManagerOptions = {},
): LocalRuntimeManager {
  return new DefaultLocalRuntimeManager(opts);
}

class DefaultLocalRuntimeManager implements LocalRuntimeManager {
  readonly rootDir: string;
  private readonly modelsDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetchImpl: LocalFetch;
  private readonly hardware:
    HardwareFacts | (() => Promise<HardwareFacts>) | undefined;
  private readonly runCommand: CommandRunner;
  private readonly spawnServer: SpawnServer;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly ownsPid: OwnsPid;
  private readonly findManagedPids: FindManagedPids;
  private readonly killPid: (pid: number, signal: NodeJS.Signals) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly startupStallMs: number | undefined;

  constructor(opts: LocalRuntimeManagerOptions) {
    this.rootDir = opts.rootDir ?? defaultLocalRuntimeDir();
    this.modelsDir = path.resolve(
      opts.modelsDir ??
        (opts.rootDir
          ? path.join(opts.rootDir, "models")
          : path.join(process.cwd(), "models")),
    );
    this.platform = opts.platform ?? process.platform;
    this.arch = opts.arch ?? process.arch;
    this.fetchImpl = opts.fetch ?? fetch;
    this.hardware = opts.hardware;
    this.runCommand = opts.runCommand ?? runCommand;
    this.spawnServer = opts.spawnServer ?? spawnDetachedServer;
    this.ownsPid =
      opts.ownsPid ??
      ((pid, serverPath) => defaultOwnsPid(pid, serverPath, this.platform));
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    this.findManagedPids =
      opts.findManagedPids ??
      ((serverPath, port) =>
        defaultFindManagedPids(serverPath, port, this.platform));
    this.killPid = opts.killPid ?? process.kill;
    this.sleep = opts.sleep ?? Bun.sleep;
    this.startupStallMs = opts.startupStallMs;
  }

  inspectModel(
    source: string,
    opts: { role?: ModelRole; file?: string; hfToken?: string } = {},
  ): Promise<ModelInspection> {
    return inspectModelSource(source, {
      ...opts,
      fetch: this.fetchImpl,
    });
  }

  async downloadModel(
    request: ModelInstallRequest,
    opts: {
      role?: ModelRole;
      onProgress?: (progress: LocalProgress) => void;
    } = {},
  ): Promise<DownloadedModel> {
    const role = opts.role ?? "model";
    const label = role === "mtp" ? "MTP model" : "model";
    opts.onProgress?.({
      stage: "resolve",
      message: `Resolving ${label} ${request.source}.`,
    });
    const resolved = await resolveModelSource(request.source, {
      role,
      file: request.file,
      sha256: request.sha256,
      hfToken: request.hfToken,
      fetch: this.fetchImpl,
    });
    const files = await installModelFiles(
          this.rootDir,
          this.fetchImpl,
      resolved.source,
      resolved.files,
      opts.onProgress,
    );
    return {
      source: resolved.source,
      label: resolved.label,
      files,
    };
  }

  async install(
    opts: InstallLocalRuntimeOptions = {},
  ): Promise<LocalInstallation> {
    const progress = opts.onProgress;
    progress?.({ stage: "detect", message: "Detecting local hardware." });
    const facts =
      typeof this.hardware === "function"
        ? await this.hardware()
        : (this.hardware ?? (await detectHardwareFacts()));
    const target = selectLocalRuntimeTarget(
      this.platform,
      this.arch,
      facts,
      opts.backend ?? "auto",
    );
    const release = opts.release?.trim() || DEFAULT_ATOMIC_RELEASE;
    const prior = await this.readInstallation();
    if (prior) {
      const current = await this.status();
      if (externalServesInstalledModel(current)) {
        throw new Error(
          `An external llama.cpp server is using ${current.endpoint}. Stop it before changing the managed installation.`,
        );
      }
      if (current.managed) await this.stop();
    }
    const runtime = await downloadAtomicBuild(this.builds(), {
      release,
      target,
      ...(prior ? { prior } : {}),
      ...(progress ? { onProgress: progress } : {}),
      beforeReplace: (buildRoot) => this.stopIfRunningFrom(buildRoot),
    });
    let committed = false;
    try {
      const models = [...(prior?.models ?? [])];
      let defaultModel = prior?.defaultModel ?? models[0]?.alias;
      let model = models.find((candidate) => candidate.alias === defaultModel);
      if (opts.model) {
        progress?.({
          stage: "resolve",
          message: `Resolving model ${opts.model.source}.`,
        });
        const resolved = await resolveModelSource(opts.model.source, {
          role: "model",
          file: opts.model.file,
          sha256: opts.model.sha256,
          hfToken: opts.model.hfToken,
          fetch: this.fetchImpl,
        });
        const files = await installModelFiles(
          this.rootDir,
          this.fetchImpl,
          resolved.source,
          resolved.files,
          progress,
        );
        const primaryPath = files[0]?.path;
        if (!primaryPath)
          throw new Error("The selected model did not resolve to any files.");
        const alias = normalizeAlias(opts.alias || resolved.label);
        model = {
          alias,
          source: resolved.source,
          files,
          primaryPath,
        };
        const existing = models.findIndex(
          (candidate) => candidate.alias === alias,
        );
        if (existing >= 0) {
          models[existing] = model;
        } else {
          models.push(model);
        }
        defaultModel ??= alias;
      }

      if (opts.mtp) {
        if (!model)
          throw new Error(
            "Install a primary model before adding an MTP model.",
          );
        progress?.({
          stage: "resolve",
          message: `Resolving MTP model ${opts.mtp.source}.`,
        });
        const resolved = await resolveModelSource(opts.mtp.source, {
          role: "mtp",
          file: opts.mtp.file,
          sha256: opts.mtp.sha256,
          hfToken: opts.mtp.hfToken,
          fetch: this.fetchImpl,
        });
        if (resolved.files.length !== 1) {
          throw new Error("MTP models must resolve to one GGUF file.");
        }
        const [mtp] = await installModelFiles(
          this.rootDir,
          this.fetchImpl,
          resolved.source,
          resolved.files,
          progress,
        );
        model = { ...model, mtp };
        const existing = models.findIndex(
          (candidate) => candidate.alias === model!.alias,
        );
        models[existing] = model;
      }

      const installation: LocalInstallation = {
        schema: 2,
        runtime,
        models,
        ...(defaultModel ? { defaultModel } : {}),
        ...(prior?.lastPort !== undefined ? { lastPort: prior.lastPort } : {}),
      };
      progress?.({
        stage: "configure",
        message: "Saving local runtime configuration.",
      });
      await this.writeInstallation(installation);
      committed = true;
      if (prior) await this.cleanupPriorRuntime(prior, installation);
      return installation;
    } catch (error) {
      if (
        !committed &&
        runtime.root !== prior?.runtime.root &&
        isManagedPath(path.join(this.rootDir, "runtime"), runtime.root)
      ) {
        await rm(runtime.root, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async listGpus(): Promise<LocalGpuList> {
    const installation = await this.readInstallation();
    if (!installation) return { gpus: [], downloadable: [] };
    return listAtomicGpus(this.builds(), installation);
  }

  async installEngine(
    backend: Exclude<LocalBackend, "auto">,
    opts: { onProgress?: (progress: LocalProgress) => void } = {},
  ): Promise<void> {
    const installation = await this.requireInstallation();
    await downloadSideBuild(this.builds(), installation, backend, {
      ...opts,
      beforeReplace: (buildRoot) => this.stopIfRunningFrom(buildRoot),
    });
  }

  async installExl3xpu(
    opts: { onProgress?: (progress: LocalProgress) => void } = {},
  ): Promise<void> {
    const progress = opts.onProgress;
    await installExl3xpuEngine(this.rootDir, {
      fetch: this.fetchImpl,
      runCommand: this.runCommand,
      download: (url, destination, sha256, size, headers) =>
        downloadVerified(
          this.fetchImpl,
          url,
          destination,
          sha256,
          size,
          progress,
          headers,
        ),
      ...(progress
        ? {
            onProgress: (message: string) =>
              progress({ stage: "download", message }),
          }
        : {}),
    });
  }

  exl3xpuInstalled(): Promise<boolean> {
    return exl3xpuEngine.installed(this.builds());
  }

  async servingEngine(
    alias?: string,
  ): Promise<{ engine: Engine; model?: InstalledLocalModel }> {
    const installation = await this.readInstallation();
    const wanted = alias ?? installation?.defaultModel;
    const model = installation?.models.find((entry) => entry.alias === wanted);
    return { engine: engineForModel(model), ...(model ? { model } : {}) };
  }

  private builds(): EngineContext {
    return {
      rootDir: this.rootDir,
      platform: this.platform,
      arch: this.arch,
      fetch: this.fetchImpl,
      runCommand: this.runCommand,
    };
  }

  /**
   * Only a server running from the build being replaced has to stop; one on
   * another build keeps playing while this one downloads beside it.
   */
  private async stopIfRunningFrom(buildRoot: string): Promise<void> {
    const running = await readRunRecord(this.rootDir);
    if (running && isManagedPath(buildRoot, running.serverPath)) {
      await this.stop();
    }
  }

  async start(
    opts: StartLocalRuntimeOptions = {},
  ): Promise<LocalRuntimeStatus> {
    if (opts.signal?.aborted) throw localRuntimeAbortError();
    const installation = await this.requireInstallation();
    const requestedModel = opts.model?.trim();
    const modelAlias =
      requestedModel ||
      installation.defaultModel ||
      installation.models[0]?.alias;
    const model = installation.models.find(
      (candidate) => candidate.alias === modelAlias,
    );
    if (!model) {
      if (requestedModel) {
        throw new Error(`Local model is not installed: ${requestedModel}`);
      }
      throw new Error(
        "No local model is installed. Run `nq local install --model <path|url|owner/repository>` first.",
      );
    }
    const engine = engineForModel(model);
    await engine.verify(this.builds(), installation, model);
    const managedRun = await this.readRunRecord();
    if (managedRun) {
      const current = await this.status();
      if (current.managed) return current;
    }

    const port = validatePort(
      opts.port ?? installation.lastPort ?? DEFAULT_LOCAL_MODEL_PORT,
    );
    const { model: _alias, ...profile } = normalizeLocalEngineProfile(opts);
    validateContextTokens(profile.contextTokens);
    validateReasoningTokens(profile.reasoningTokens);
    const endpoint = `http://127.0.0.1:${port}`;
    const occupied = await probeModels(this.fetchImpl, endpoint);
    if (occupied) {
      throw new Error(
        `${endpoint} is already in use by another llama.cpp server.`,
      );
    }

    const launch = await engine.launch(this.builds(), installation, model, {
      ...profile,
      port,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    await mkdir(path.join(this.rootDir, "logs"), { recursive: true });
    const logPath = path.join(this.rootDir, "logs", engine.logFile);
    const logOffset = await fileSizeOrZero(logPath);
    opts.onProgress?.({ stage: "start", message: launch.startMessage });
    if (installation.lastPort !== port) {
      await this.writeInstallation({ ...installation, lastPort: port });
    }
    if (opts.signal?.aborted) throw localRuntimeAbortError();
    let pid: number;
    try {
      pid = await this.spawnServer(launch.command, launch.args, logPath);
    } catch (error) {
      throw launch.spawnError?.(error) ?? error;
    }
    const engineName = recordedEngineName(engine);
    await this.writeRunRecord({
      schema: 1,
      pid,
      port,
      alias: model.alias,
      serverPath: launch.command,
      startedAt: new Date().toISOString(),
      speculative: launch.speculative,
      ...(engineName ? { engine: engineName } : {}),
    });
    const stallMs =
      engine.stallMs === undefined ? undefined : (this.startupStallMs ?? engine.stallMs);
    return this.awaitReady({
      pid,
      port,
      logPath,
      logOffset,
      engine,
      ...(stallMs !== undefined ? { stallMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  private async awaitReady(opts: {
    pid: number;
    port: number;
    logPath: string;
    logOffset: number;
    engine: Engine;
    /** give up when the log has not grown for this long */
    stallMs?: number;
    signal?: AbortSignal;
  }): Promise<LocalRuntimeStatus> {
    const endpoint = `http://127.0.0.1:${opts.port}`;
    const engineName = opts.engine.label;
    const timeoutMs = opts.engine.startTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    let logSize = await fileSizeOrZero(opts.logPath);
    let lastGrowth = Date.now();
    while (Date.now() < deadline) {
      if (opts.stallMs !== undefined) {
        const size = await fileSizeOrZero(opts.logPath);
        if (size !== logSize) {
          logSize = size;
          lastGrowth = Date.now();
        } else if (Date.now() - lastGrowth > opts.stallMs) {
          await this.stop();
          throw await atomicStartupError(
            `${engineName} stopped making progress for ${Math.round(opts.stallMs / 60_000)} minutes while starting. ` +
              "The GPU driver may have reset a job it was waiting on (see `journalctl -k`); loading again usually works.",
            opts.logPath,
            opts.logOffset,
          );
        }
      }
      if (opts.signal?.aborted) {
        await this.stop();
        throw localRuntimeAbortError();
      }
      const live = await probeModels(this.fetchImpl, endpoint);
      if (live) return this.status({ port: opts.port });
      if (!this.isPidAlive(opts.pid)) {
        await this.clearRunRecord();
        throw await atomicStartupError(
          `${engineName} exited while loading the model.`,
          opts.logPath,
          opts.logOffset,
        );
      }
      await this.sleep(500);
    }

    await this.stop();
    throw await atomicStartupError(
      `${engineName} did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`,
      opts.logPath,
      opts.logOffset,
    );
  }

  installation(): Promise<LocalInstallation | undefined> {
    return this.readInstallation();
  }

  async status(opts: { port?: number } = {}): Promise<LocalRuntimeStatus> {
    const installation = await this.readInstallation();
    const run = await this.readRunRecord();
    const pidAlive = run ? this.isPidAlive(run.pid) : false;
    const alive =
      run && pidAlive ? await this.ownsPid(run.pid, run.serverPath) : false;
    if (run && pidAlive && !alive) await this.clearRunRecord();
    const port = validatePort(
      run && alive
        ? run.port
        : (opts.port ??
            run?.port ??
            installation?.lastPort ??
            DEFAULT_LOCAL_MODEL_PORT),
    );
    const endpoint = `http://127.0.0.1:${port}`;
    const probe = await probeModels(this.fetchImpl, endpoint);

    if (probe) {
      return {
        state: run && alive ? "running" : "external",
        endpoint,
        installed: installation !== undefined,
        managed: Boolean(run && alive),
        models: probe,
        ...(run && alive ? { pid: run.pid } : {}),
        ...(run && alive && run.speculative
          ? { speculative: run.speculative }
          : {}),
        ...(installation ? { installation } : {}),
      };
    }
    if (!installation) {
      if (run && !alive) await this.clearRunRecord();
      return {
        state: "not-installed",
        endpoint,
        installed: false,
        managed: false,
        models: [],
      };
    }
    if (run && alive) {
      const startedAt = Date.parse(run.startedAt);
      const window = engineNamed(run.engine).startTimeoutMs;
      const loading =
        Number.isFinite(startedAt) && Date.now() - startedAt <= window;
      return {
        state: loading ? "starting" : "unhealthy",
        endpoint,
        installed: true,
        managed: true,
        models: [],
        pid: run.pid,
        installation,
        ...(!loading
          ? {
              problem: `The server process is alive but ${endpoint}/v1/models is not responding.`,
            }
          : {}),
      };
    }
    if (run) await this.clearRunRecord();
    return {
      state: "stopped",
      endpoint,
      installed: true,
      managed: false,
      models: [],
      installation,
    };
  }

  async stop(): Promise<LocalRuntimeStatus> {
    const run = await this.readRunRecord();
    if (run && this.isPidAlive(run.pid)) {
      if (!(await this.ownsPid(run.pid, run.serverPath))) {
        await this.clearRunRecord();
        throw new Error(
          `Refusing to stop PID ${run.pid} because it is not the NQ-managed Atomic executable.`,
        );
      }
      await this.terminatePid(run.pid);
    }

    // A failed start, a crash, or a host that exited without stopping the engine
    // leaves Atomic holding the GPU with no run record pointing at it. The next
    // start then fits its layers to whatever VRAM the orphan left free, so reap
    // any server still bound to our engine port before reporting a clean stop.
    await this.reapOrphanedServers(run?.port);

    await this.clearRunRecord();
    return this.status(run ? { port: run.port } : {});
  }

  private terminatePid(pid: number): Promise<void> {
    return terminateProcess(pid, {
      isPidAlive: this.isPidAlive,
      killPid: this.killPid,
      sleep: this.sleep,
    });
  }

  /**
   * Kills Atomic servers that are ours by both executable and engine port. Both
   * must match so a server the user started by hand from the same build is left
   * alone.
   */
  private async reapOrphanedServers(recordedPort?: number): Promise<void> {
    const installation = await this.readInstallation();
    if (!installation) return;
    const port =
      recordedPort ?? installation.lastPort ?? DEFAULT_LOCAL_MODEL_PORT;

    for (const build of await installedAtomicBuilds(this.builds(), installation)) {
      let pids: number[];
      try {
        pids = await this.findManagedPids(build.serverPath, port);
      } catch {
        continue;
      }
      for (const pid of pids) {
        if (!this.isPidAlive(pid)) continue;
        await this.terminatePid(pid);
      }
    }
  }

  async listMmproj(): Promise<InstalledModelFile[]> {
    return listMmprojFiles(await this.readInstallation(), this.catalogDirs());
  }

  async setModelMmproj(
    alias: string,
    file?: string,
  ): Promise<LocalInstallation> {
    const installation = await this.requireInstallation();
    const index = installation.models.findIndex(
      (model) => model.alias === alias,
    );
    if (index < 0) throw new Error(`Local model is not installed: ${alias}`);

    const models = [...installation.models];
    const model = models[index]!;
    if (file === undefined) {
      const { mmproj: _cleared, ...rest } = model;
      models[index] = rest;
    } else {
      const resolved = path.resolve(file);
      if (!(await fileExists(resolved))) {
        throw new Error(`Projector file not found: ${resolved}`);
      }
      if (!isMmprojFile(resolved)) {
        throw new Error(
          `Not a projector file (expected "mmproj" in the name): ${resolved}`,
        );
      }
      const info = await stat(resolved);
      models[index] = {
        ...model,
        mmproj: {
          name: path.basename(resolved),
          path: resolved,
          external: !isManagedPath(path.join(this.rootDir, "models"), resolved),
          size: info.size,
        },
      };
    }
    const next = { ...installation, models };
    await this.writeInstallation(next);
    return next;
  }

  async uninstall(): Promise<void> {
    const current = await this.status();
    if (externalServesInstalledModel(current)) {
      throw new Error(
        `An external llama.cpp server is using ${current.endpoint}. Stop it before uninstalling local files.`,
      );
    }
    await this.stop();
    await rm(this.rootDir, { recursive: true, force: true });
  }

  private async cleanupPriorRuntime(
    prior: LocalInstallation,
    next: LocalInstallation,
  ): Promise<void> {
    if (
      prior.runtime.root !== next.runtime.root &&
      isManagedPath(this.rootDir, prior.runtime.root)
    ) {
      await rm(prior.runtime.root, { recursive: true, force: true });
    }
  }

  private async requireInstallation(): Promise<LocalInstallation> {
    const installation = await this.readInstallation();
    if (!installation) {
      throw new Error("Atomic is not installed. Run `nq local install` first.");
    }
    return installation;
  }

  /** The installation with its catalog refreshed from the model directories. */
  private async readInstallation(): Promise<LocalInstallation | undefined> {
    const installation = await readInstallationRecord(this.rootDir);
    if (!installation) return undefined;
    try {
      return await refreshModelCatalog(installation, this.catalogDirs());
    } catch (error) {
      throw new Error(
        `Invalid local runtime state at ${path.join(this.rootDir, "installation.json")}: ${errorMessage(error)}`,
      );
    }
  }

  private catalogDirs(): { modelsDir: string; rootDir: string } {
    return { modelsDir: this.modelsDir, rootDir: this.rootDir };
  }

  private writeInstallation(installation: LocalInstallation): Promise<void> {
    return writeInstallationRecord(this.rootDir, installation);
  }

  private readRunRecord(): Promise<RunRecord | undefined> {
    return readRunRecord(this.rootDir);
  }

  private writeRunRecord(record: RunRecord): Promise<void> {
    return writeRunRecord(this.rootDir, record);
  }

  private clearRunRecord(): Promise<void> {
    return clearRunRecord(this.rootDir);
  }
}

async function probeModels(
  fetchImpl: LocalFetch,
  endpoint: string,
): Promise<string[] | undefined> {
  try {
    const response = await fetchImpl(`${endpoint}/v1/models`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("data" in body) ||
      !Array.isArray(body.data)
    ) {
      return [];
    }
    return body.data.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || !("id" in entry)) return [];
      return typeof entry.id === "string" ? [entry.id] : [];
    });
  } catch {
    return undefined;
  }
}

async function atomicStartupError(
  message: string,
  logPath: string,
  offset: number,
): Promise<Error> {
  const detail = await readLogSince(logPath, offset);
  return new Error(`${message}${detail ? `\n${detail}` : ""}\nLog: ${logPath}`);
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid local server port: ${port}.`);
  }
  return port;
}

function validateReasoningTokens(tokens: number): number {
  if (!Number.isInteger(tokens) || tokens < -1) {
    throw new Error(`Invalid local reasoning token budget: ${tokens}.`);
  }
  return tokens;
}

function externalServesInstalledModel(status: LocalRuntimeStatus): boolean {
  if (status.state !== "external") return false;
  const aliases = status.installation?.models.map((model) => model.alias) ?? [];
  return aliases.some((alias) => status.models.includes(alias));
}

function validateContextTokens(tokens: number): number {
  if (!Number.isInteger(tokens) || tokens < 1) {
    throw new Error(`Invalid context token count: ${tokens}.`);
  }
  return tokens;
}

function localRuntimeAbortError(): Error {
  return Object.assign(new Error("Local model startup was cancelled."), {
    name: "AbortError",
  });
}
