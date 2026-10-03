import { saveNqModel } from "../login.ts";
import {
  ModelSelectionRequiredError,
  type ModelInspection,
} from "@nq/local-inference/model_source.ts";
import {
  createLocalRuntimeManager,
  type LocalProgress,
} from "@nq/local-inference/runtime.ts";
import type { LocalBackend } from "@nq/local-inference/target.ts";
import {
  createLocalInferenceHostClient,
  type LocalInferenceHostStatus,
} from "@nq/local-inference/host.ts";
import { questionOnStderr } from "./campaign.ts";
import { fail } from "./fail.ts";
import { runShare } from "./share.ts";

type LocalCliOptions = {
  command:
    | "inspect"
    | "download"
    | "install"
    | "start"
    | "status"
    | "stop"
    | "uninstall"
    | "mmproj";
  modelSource?: string;
  modelFile?: string;
  modelSha256?: string;
  mtpSource?: string;
  mtpFile?: string;
  mtpSha256?: string;
  mmprojTarget?: string;
  mmprojFile?: string;
  mmprojClear?: boolean;
  alias?: string;
  backend?: LocalBackend;
  /** `install --engine exl3xpu`: the engine for EXL3 models instead of Atomic. */
  engine?: "exl3xpu";
  release?: string;
  contextTokens?: number;
  reasoningTokens?: number;
  port?: number;
  json: boolean;
  yes: boolean;
};

export async function runLocal(
  args: string[],
  globalModel: string | undefined,
  globalPort: number | undefined,
  configPath: string,
  signal?: AbortSignal,
): Promise<number> {
  try {
    if (args[0] === "share") return await runShare(args.slice(1), configPath, signal);
    const options = parseLocalCliOptions(args, globalModel, globalPort);
    const manager = createLocalRuntimeManager();
    const host = createLocalInferenceHostClient({ port: options.port });
    switch (options.command) {
      case "inspect": {
        if (!options.modelSource) {
          throw new Error(
            "Usage: nq local inspect <path|url|owner/repository> [--model-file <file>]",
          );
        }
        const inspection = await manager.inspectModel(options.modelSource, {
          file: options.modelFile,
        });
        if (options.json) {
          console.log(JSON.stringify(inspection, null, 2));
        } else {
          printModelInspection(inspection);
        }
        return 0;
      }
      case "download": {
        if (!options.modelSource) {
          throw new Error(
            "Usage: nq local download --model <path|url|owner/repository> [--model-file <file>]",
          );
        }
        const downloaded = await manager.downloadModel(
          {
            source: options.modelSource,
            file: options.modelFile,
            sha256: options.modelSha256,
          },
          { onProgress: createLocalProgressPrinter() },
        );
        if (options.json) {
          console.log(JSON.stringify(downloaded, null, 2));
        } else {
          console.log(`Downloaded ${downloaded.label}.`);
          for (const file of downloaded.files) console.log(file.path);
        }
        return 0;
      }
      case "install": {
        if (options.engine === "exl3xpu") {
          // beside Atomic: the running Game Master keeps its engine
          await manager.installExl3xpu({ onProgress: createLocalProgressPrinter() });
          console.log("exl3xpu installed; EXL3 models in your model folders now load on it.");
          return 0;
        }
        await host.stop();
        const progress = createLocalProgressPrinter();
        const installation = await manager.install({
          backend: options.backend,
          release: options.release,
          ...(options.modelSource
            ? {
                model: {
                  source: options.modelSource,
                  file: options.modelFile,
                  sha256: options.modelSha256,
                },
              }
            : {}),
          ...(options.mtpSource
            ? {
                mtp: {
                  source: options.mtpSource,
                  file: options.mtpFile,
                  sha256: options.mtpSha256,
                },
              }
            : {}),
          alias: options.alias,
          onProgress: progress,
        });
        if (installation.defaultModel) {
          await saveNqModel(
            configPath,
            `llama.cpp/${installation.defaultModel}`,
          );
        }
        if (options.json) {
          console.log(JSON.stringify(installation, null, 2));
        } else {
          console.log(
            `Atomic ${installation.runtime.release} installed for ${installation.runtime.target.backend}.`,
          );
          if (installation.defaultModel) {
            console.log(
              `Local Game Masters: ${installation.models.length} · default ${installation.defaultModel}`,
            );
          } else {
            console.log(
              "Runtime installed. Add a model with `nq local install --model <path|url|owner/repository>`.",
            );
          }
        }
        return 0;
      }
      case "start": {
        const status = await host.activate(
          {
            ...(options.contextTokens !== undefined
              ? { contextTokens: options.contextTokens }
              : {}),
            ...(options.reasoningTokens !== undefined
              ? { reasoningTokens: options.reasoningTokens }
              : {}),
          },
          { pin: true },
        );
        printLocalHostStatus(status, options.json);
        return 0;
      }
      case "status": {
        const status = await host.status();
        printLocalHostStatus(status, options.json);
        return 0;
      }
      case "mmproj": {
        if (!options.mmprojTarget) {
          const files = await manager.listMmproj();
          if (options.json) {
            console.log(JSON.stringify(files, null, 2));
          } else if (files.length === 0) {
            console.log(
              'No projector files found. Projectors have "mmproj" in the filename.',
            );
          } else {
            console.log("Projectors available:");
            for (const file of files) {
              console.log(`  ${file.name}  ${formatByteSize(file.size ?? 0)}`);
              console.log(`    ${file.path}`);
            }
            console.log("\nAttach one with: nq local mmproj <model> <file>");
          }
          return 0;
        }
        if (!options.mmprojFile && !options.mmprojClear) {
          throw new Error(
            "Usage: nq local mmproj <model> <file>, or nq local mmproj <model> --none to clear.",
          );
        }
        const installation = await manager.setModelMmproj(
          options.mmprojTarget,
          options.mmprojClear ? undefined : options.mmprojFile,
        );
        const model = installation.models.find(
          (candidate) => candidate.alias === options.mmprojTarget,
        );
        if (options.json) {
          console.log(JSON.stringify(model, null, 2));
        } else if (model?.mmproj) {
          console.log(`${model.alias}: projector set to ${model.mmproj.name}`);
        } else {
          console.log(`${options.mmprojTarget}: projector cleared`);
        }
        return 0;
      }
      case "stop": {
        await host.stop();
        printLocalHostStatus(await host.status(), options.json);
        return 0;
      }
      case "uninstall": {
        await host.stop();
        if (!options.yes) {
          if (!process.stdin.isTTY) {
            throw new Error(
              "Refusing to uninstall the local runtime without confirmation. Re-run in a terminal, or pass --yes.",
            );
          }
          const answer = await questionOnStderr(
            "Remove the NQ-managed Atomic runtime and downloaded models? This cannot be undone. [y/N] ",
          );
          if (!/^(?:y|yes)$/i.test(answer.trim())) {
            console.error("Cancelled. Local runtime not removed.");
            return 1;
          }
        }
        await manager.uninstall();
        console.log(
          "Removed the NQ-managed Atomic runtime and downloaded models.",
        );
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof ModelSelectionRequiredError) {
      console.error(err.message);
      printModelInspection(err.inspection, true);
      return 1;
    }
    return fail(err);
  }
}

function parseLocalCliOptions(
  args: string[],
  globalModel: string | undefined,
  globalPort: number | undefined,
): LocalCliOptions {
  const rawCommand = args[0] ?? "status";
  if (
    rawCommand !== "inspect" &&
    rawCommand !== "download" &&
    rawCommand !== "install" &&
    rawCommand !== "start" &&
    rawCommand !== "status" &&
    rawCommand !== "stop" &&
    rawCommand !== "uninstall" &&
    rawCommand !== "mmproj"
  ) {
    throw new Error(
      "Usage: nq local <inspect|download|install|start|status|stop|uninstall|mmproj> [options]",
    );
  }
  const options: LocalCliOptions = {
    command: rawCommand,
    modelSource: globalModel,
    port: globalPort,
    json: false,
    yes: false,
  };
  const positionals: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    if (arg === "--none") {
      options.mmprojClear = true;
      continue;
    }
    if (arg === "--model-file") {
      if (!next) throw new Error("Missing value for --model-file.");
      options.modelFile = next;
      i++;
      continue;
    }
    if (arg === "--model-sha256") {
      if (!next) throw new Error("Missing value for --model-sha256.");
      options.modelSha256 = next;
      i++;
      continue;
    }
    if (arg === "--mtp") {
      if (!next) throw new Error("Missing value for --mtp.");
      options.mtpSource = next;
      i++;
      continue;
    }
    if (arg === "--mtp-file") {
      if (!next) throw new Error("Missing value for --mtp-file.");
      options.mtpFile = next;
      i++;
      continue;
    }
    if (arg === "--mtp-sha256") {
      if (!next) throw new Error("Missing value for --mtp-sha256.");
      options.mtpSha256 = next;
      i++;
      continue;
    }
    if (arg === "--alias") {
      if (!next) throw new Error("Missing value for --alias.");
      options.alias = next;
      i++;
      continue;
    }
    if (arg === "--engine") {
      if (next !== "exl3xpu") {
        throw new Error(`Unknown local engine: ${next ?? "(missing)"}. Available: exl3xpu.`);
      }
      options.engine = next;
      i++;
      continue;
    }
    if (arg === "--backend") {
      if (!next) throw new Error("Missing value for --backend.");
      if (
        next !== "auto" &&
        next !== "cpu" &&
        next !== "vulkan" &&
        next !== "cuda-12.4" &&
        next !== "cuda-13.3" &&
        next !== "rocm" &&
        next !== "metal"
      ) {
        throw new Error(`Unknown Atomic backend: ${next}.`);
      }
      options.backend = next;
      i++;
      continue;
    }
    if (arg === "--release") {
      if (!next) throw new Error("Missing value for --release.");
      options.release = next;
      i++;
      continue;
    }
    if (arg === "--ctx") {
      if (!next) throw new Error("Missing value for --ctx.");
      options.contextTokens = Number(next);
      i++;
      continue;
    }
    if (arg === "--reasoning-tokens") {
      if (!next) throw new Error("Missing value for --reasoning-tokens.");
      options.reasoningTokens = Number(next);
      i++;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown local argument: ${arg}`);
    positionals.push(arg);
  }
  if (rawCommand === "mmproj") {
    // nq local mmproj                    -> list projectors
    // nq local mmproj <alias> <file>     -> attach
    // nq local mmproj <alias> --none     -> clear
    if (positionals.length > 2) {
      throw new Error(`Unexpected local argument: ${positionals[2]}`);
    }
    if (positionals[0]) options.mmprojTarget = positionals[0];
    if (positionals[1]) options.mmprojFile = positionals[1];
    return options;
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected local argument: ${positionals[1]}`);
  }
  if (positionals[0]) {
    if (options.modelSource) {
      throw new Error(
        "Specify the model once, either with --model or as the inspect/install argument.",
      );
    }
    options.modelSource = positionals[0];
  }
  return options;
}

function printModelInspection(
  inspection: ModelInspection,
  asGuidance = false,
): void {
  const heading = inspection.repository
    ? `Models in ${inspection.repository}:`
    : `Model source ${inspection.source}:`;
  console.error(heading);
  for (const candidate of inspection.candidates) {
    const details: string[] = [];
    if (candidate.files.length > 1)
      details.push(`${candidate.files.length} shards`);
    if (candidate.size !== undefined)
      details.push(formatByteSize(candidate.size));
    const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
    console.error(`  ${candidate.id}${suffix}`);
  }
  if (asGuidance) {
    console.error("Choose one with --model-file <file>.");
  }
}

function formatByteSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function createLocalProgressPrinter(): (progress: LocalProgress) => void {
  let prior = "";
  return (progress) => {
    const percent =
      progress.total && progress.received !== undefined
        ? ` ${Math.floor((progress.received / progress.total) * 100)}%`
        : "";
    const bucket = percent
      ? percent.replace(/\d+/, (value) =>
          String(Math.floor(Number(value) / 5) * 5),
        )
      : "";
    const key = `${progress.stage}:${progress.file ?? ""}:${bucket || progress.message}`;
    if (key === prior) return;
    prior = key;
    console.error(`${progress.message}${bucket}`);
  };
}

function printLocalHostStatus(
  status: LocalInferenceHostStatus,
  json: boolean,
): void {
  if (json) {
    const { runtime, pid: hostPid, phase, ...host } = status;
    console.log(
      JSON.stringify(
        {
          ...runtime,
          endpoint: status.endpoint ?? runtime.endpoint,
          engineEndpoint: runtime.endpoint,
          ...host,
          hostPhase: phase,
          ...(hostPid !== undefined ? { hostPid } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!status.runtime.installed) {
    console.log("Atomic is not installed.");
  } else if (!status.hostRunning) {
    console.log("Local inference is installed and stopped.");
  } else {
    const labelByPhase: Record<LocalInferenceHostStatus["phase"], string> = {
      idle: "Local inference host is ready; no Game Master is loaded.",
      "starting-game-master": "The local Game Master is loading.",
      "game-master": "The local Game Master is ready.",
      illustrating: "Local Illustration is running.",
      "restoring-game-master": "The local Game Master is reloading.",
      failed: "Local inference needs attention.",
    };
    console.log(labelByPhase[status.phase]);
  }
  if (status.endpoint) console.log(`Endpoint: ${status.endpoint}`);
  if (status.runtime.installation) {
    console.log(
      `Runtime: ${status.runtime.installation.runtime.release} (${status.runtime.installation.runtime.target.backend})`,
    );
    if (status.runtime.installation.defaultModel) {
      console.log(
        `Configured models: ${status.runtime.installation.models.length} · default ${status.runtime.installation.defaultModel}`,
      );
    }
  }
  if (status.runtime.speculative) {
    console.log(`Speculative decoding: ${status.runtime.speculative}`);
  }
  if (status.problem ?? status.runtime.problem) {
    console.log(`Problem: ${status.problem ?? status.runtime.problem}`);
  }
}
