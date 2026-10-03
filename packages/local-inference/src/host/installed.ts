import path from "node:path";
import type { LocalProgress } from "../runtime.ts";
import type { LocalBackend } from "../target.ts";
import type { LocalTuning } from "../tuning.ts";
import type { LocalGpuList } from "../profile.ts";
import type { ModelEngineInspection } from "../gguf.ts";
import { engineForModel, recordedEngineName } from "../engines/registry.ts";
import type { ModelIdentity } from "../almanac.ts";
import {
  createLocalRuntimeManager,
  type LocalRuntimeStatus,
} from "../runtime.ts";

export async function localRuntimeInstallationStatus(
  rootDir?: string,
): Promise<LocalRuntimeStatus> {
  return createLocalRuntimeManager({ rootDir }).status();
}

export async function listLocalMmproj(
  rootDir?: string,
): Promise<Array<{ path: string; name: string; size?: number }>> {
  const manager = createLocalRuntimeManager({
    ...(rootDir ? { rootDir } : {}),
  });
  const files = await manager.listMmproj();
  return files.map((file) => ({
    path: file.path,
    name: file.name,
    ...(file.size !== undefined ? { size: file.size } : {}),
  }));
}

export async function listLocalGpus(rootDir?: string): Promise<LocalGpuList> {
  return createLocalRuntimeManager({ ...(rootDir ? { rootDir } : {}) }).listGpus();
}

export async function installLocalEngine(
  backend: Exclude<LocalBackend, "auto">,
  opts: { rootDir?: string; onProgress?: (progress: LocalProgress) => void } = {},
): Promise<void> {
  await createLocalRuntimeManager({
    ...(opts.rootDir ? { rootDir: opts.rootDir } : {}),
  }).installEngine(
    backend,
    opts.onProgress ? { onProgress: opts.onProgress } : {},
  );
}

export async function localExl3xpuInstalled(rootDir?: string): Promise<boolean> {
  return createLocalRuntimeManager({ ...(rootDir ? { rootDir } : {}) }).exl3xpuInstalled();
}

export async function installLocalExl3xpu(
  opts: { rootDir?: string; onProgress?: (progress: LocalProgress) => void } = {},
): Promise<void> {
  await createLocalRuntimeManager({
    ...(opts.rootDir ? { rootDir: opts.rootDir } : {}),
  }).installExl3xpu(opts.onProgress ? { onProgress: opts.onProgress } : {});
}

export async function listInstalledLocalModels(
  rootDir?: string,
): Promise<
  Array<{
    id: string;
    name: string;
    size?: number;
    mmproj?: string;
    /** The model's own sampling recommendations, from its GGUF. */
    sampling?: LocalTuning;
    /** What the Almanac recognises the model by. */
    identity: ModelIdentity;
    /** The engine that serves it, when not Atomic: exl3xpu for EXL3 folders. */
    engine?: NonNullable<ReturnType<typeof recordedEngineName>>;
  }>
> {
  // the Home lists models on every snapshot; reading disk is enough, and
  // probing the engine port would touch whatever else listens there
  const installation = await createLocalRuntimeManager({
    ...(rootDir ? { rootDir } : {}),
  }).installation();
  return Promise.all(
    (installation?.models ?? []).map(async (model) => {
      const sizes = model.files.map((file) => file.size);
      const size = sizes.every((value): value is number => value !== undefined)
        ? sizes.reduce((total, value) => total + value, 0)
        : undefined;
      const engine = engineForModel(model);
      const inspection = await engine.inspect(model);
      const { sampling } = inspection;
      const identity = installedModelIdentity(model, inspection);
      const engineName = recordedEngineName(engine);
      return {
        id: model.alias,
        name: identity.file || model.alias,
        identity,
        ...(size !== undefined ? { size } : {}),
        ...(model.mmproj ? { mmproj: model.mmproj.path } : {}),
        ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
        ...(engineName ? { engine: engineName } : {}),
      };
    }),
  );
}

/** What the Almanac knows an installed model by: its file and its header. */
export function installedModelIdentity(
  model: { alias: string; primaryPath: string },
  inspection: ModelEngineInspection,
): ModelIdentity {
  const stem = path.basename(model.primaryPath).replace(/\.gguf$/i, "");
  let file = stem;
  try {
    // downloads keep URL escapes in the name ("%CE%A9FFF…")
    file = decodeURIComponent(stem);
  } catch {
    // not an escape sequence after all
  }
  return {
    file,
    alias: model.alias,
    ...(inspection.architecture ? { architecture: inspection.architecture } : {}),
    ...inspection.identity,
  };
}

/** An installed model's GGUF header facts: architecture, chat template knobs. */
export async function inspectInstalledLocalModel(
  alias: string,
  rootDir?: string,
): Promise<ModelEngineInspection | undefined> {
  const installation = await createLocalRuntimeManager({
    ...(rootDir ? { rootDir } : {}),
  }).installation();
  const model = installation?.models.find((entry) => entry.alias === alias);
  if (!model) return undefined;
  return engineForModel(model).inspect(model);
}
