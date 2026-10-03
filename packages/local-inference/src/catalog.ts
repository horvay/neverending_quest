/**
 * The model catalog: what the model directories hold, matched against the
 * models `installation.json` registers. Registered models keep their alias
 * and companions (MTP draft, projector) as long as their files exist; any
 * other GGUF (shards grouped) is listed under an alias from its filename, and
 * EXL3 folders join as exl3xpu models. `*mmproj*` files are projectors,
 * offered per model rather than listed as models.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ENGINES } from "./engines/registry.ts";
import { compareStrings, isManagedPath, isMissingFileError } from "./files.ts";
import type {
  InstalledLocalModel,
  InstalledModelFile,
  LocalInstallation,
} from "./installation.ts";

/** The catalog as the model directories hold it now. */
export async function refreshModelCatalog(
  installation: LocalInstallation,
  dirs: { modelsDir: string; rootDir: string },
): Promise<LocalInstallation> {
  const directories = new Set([
    dirs.modelsDir,
    path.join(dirs.rootDir, "models"),
  ]);
  for (const model of installation.models) {
    for (const file of model.files) directories.add(path.dirname(file.path));
    if (model.mtp) directories.add(path.dirname(model.mtp.path));
    if (model.mmproj) directories.add(path.dirname(model.mmproj.path));
  }
  const models = await discoverInstalledModels(
    [...directories],
    installation.models,
    dirs.rootDir,
  );
  const requestedDefault = installation.defaultModel;
  const defaultModel =
    requestedDefault &&
    models.some((model) => model.alias === requestedDefault)
      ? requestedDefault
      : models[0]?.alias;
  const { defaultModel: _staleDefault, ...base } = installation;
  return {
    ...base,
    models,
    ...(defaultModel ? { defaultModel } : {}),
  };
}

/** Every *mmproj*.gguf in the model directories, for a projector picker. */
export async function listMmprojFiles(
  installation: LocalInstallation | undefined,
  dirs: { modelsDir: string; rootDir: string },
): Promise<InstalledModelFile[]> {
  const directories = new Set([
    dirs.modelsDir,
    path.join(dirs.rootDir, "models"),
  ]);
  for (const model of installation?.models ?? []) {
    for (const file of model.files) directories.add(path.dirname(file.path));
    if (model.mmproj) directories.add(path.dirname(model.mmproj.path));
  }
  const scanned = new Map<string, CatalogFile>();
  for (const directory of [...directories]) {
    await scanGgufDirectory(path.resolve(directory), scanned);
  }
  const managedModelsRoot = path.join(dirs.rootDir, "models");
  return [...scanned.values()]
    .filter((file) => isMmprojFile(file.path))
    .map((file) => catalogInstalledFile(file, managedModelsRoot))
    .sort((left, right) => compareStrings(left.name, right.name));
}

type CatalogFile = {
  canonicalPath: string;
  path: string;
  size: number;
};

async function discoverInstalledModels(
  directories: string[],
  registered: InstalledLocalModel[],
  runtimeRoot: string,
): Promise<InstalledLocalModel[]> {
  const scanned = new Map<string, CatalogFile>();
  for (const directory of [
    ...new Set(directories.map((value) => path.resolve(value))),
  ].sort()) {
    await scanGgufDirectory(directory, scanned);
  }

  const models: InstalledLocalModel[] = [];
  const consumed = new Set<string>();
  const usedAliases = new Set<string>();
  const managedModelsRoot = path.join(runtimeRoot, "models");

  for (const model of registered) {
    const primary = await catalogFileForPath(scanned, model.primaryPath);
    if (!primary || consumed.has(primary.canonicalPath)) continue;

    const files: InstalledModelFile[] = [];
    for (const registeredFile of model.files) {
      const discovered = await catalogFileForPath(scanned, registeredFile.path);
      if (!discovered) continue;
      consumed.add(discovered.canonicalPath);
      files.push({
        ...registeredFile,
        name: path.basename(discovered.path),
        path: discovered.path,
        size: discovered.size,
      });
    }
    if (
      !files.some(
        (file) => path.resolve(file.path) === path.resolve(primary.path),
      )
    ) {
      consumed.add(primary.canonicalPath);
      files.unshift(catalogInstalledFile(primary, managedModelsRoot));
    }

    let mmproj: InstalledModelFile | undefined;
    if (model.mmproj) {
      const discovered = await catalogFileForPath(scanned, model.mmproj.path);
      if (discovered) {
        consumed.add(discovered.canonicalPath);
        mmproj = {
          ...model.mmproj,
          name: path.basename(discovered.path),
          path: discovered.path,
          size: discovered.size,
        };
      }
    }

    let mtp: InstalledModelFile | undefined;
    if (model.mtp) {
      const discovered = await catalogFileForPath(scanned, model.mtp.path);
      if (discovered) {
        consumed.add(discovered.canonicalPath);
        mtp = {
          ...model.mtp,
          name: path.basename(discovered.path),
          path: discovered.path,
          size: discovered.size,
        };
      }
    }

    const alias = uniqueModelAlias(model.alias, usedAliases);
    models.push({
      ...model,
      alias,
      files,
      primaryPath: primary.path,
      ...(mtp ? { mtp } : {}),
      ...(mmproj ? { mmproj } : {}),
    });
  }

  const groups = new Map<string, CatalogFile[]>();
  for (const file of scanned.values()) {
    if (consumed.has(file.canonicalPath)) continue;
    if (isMmprojFile(file.path)) continue;
    const key = modelFileGroupKey(file.path);
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }

  for (const [key, group] of [...groups.entries()].sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    group.sort((left, right) => compareStrings(left.path, right.path));
    const primary = group[0]!;
    const alias = uniqueModelAlias(
      aliasFromModelStem(path.basename(key)),
      usedAliases,
    );
    models.push({
      alias,
      source: primary.path,
      files: group.map((file) => catalogInstalledFile(file, managedModelsRoot)),
      primaryPath: primary.path,
    });
  }

  // formats the GGUF scan does not see, from the engines that serve them
  for (const engine of ENGINES) {
    models.push(
      ...((await engine.discoverModels?.(
        directories,
        (name) => uniqueModelAlias(name, usedAliases),
        managedModelsRoot,
      )) ?? []),
    );
  }
  return models.sort((left, right) => compareStrings(left.alias, right.alias));
}

async function scanGgufDirectory(
  directory: string,
  files: Map<string, CatalogFile>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  entries.sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanGgufDirectory(filename, files);
      continue;
    }
    if (!/\.gguf$/i.test(entry.name)) continue;
    let info;
    try {
      info = await stat(filename);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    if (!info.isFile()) continue;
    const canonicalPath = await realpath(filename);
    files.set(canonicalPath, {
      canonicalPath,
      path: filename,
      size: info.size,
    });
  }
}

async function catalogFileForPath(
  files: Map<string, CatalogFile>,
  filename: string,
): Promise<CatalogFile | undefined> {
  try {
    return files.get(await realpath(filename));
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function catalogInstalledFile(
  file: CatalogFile,
  managedModelsRoot: string,
): InstalledModelFile {
  return {
    name: path.basename(file.path),
    path: file.path,
    external: !isManagedPath(managedModelsRoot, file.path),
    size: file.size,
  };
}

/** Projectors are companion files; they are offered per model, not listed as models. */
export function isMmprojFile(filename: string): boolean {
  return /mmproj/i.test(path.basename(filename));
}

function modelFileGroupKey(filename: string): string {
  const basename = path.basename(filename);
  const shard = /^(.*)-\d{5}-of-\d{5}\.gguf$/i.exec(basename);
  const stem = shard?.[1] ?? basename.replace(/\.gguf$/i, "");
  return path.join(path.dirname(filename), stem);
}

function aliasFromModelStem(stem: string): string {
  const withoutQuantization = stem.replace(
    /-(?:(?:ud-)?(?:i|t)?q\d(?:_[a-z0-9]+)*|bf16|f16|f32)$/i,
    "",
  );
  return normalizeAlias(withoutQuantization);
}

function uniqueModelAlias(alias: string, used: Set<string>): string {
  const base = normalizeAlias(alias);
  let candidate = base;
  for (let suffix = 2; used.has(candidate); suffix++)
    candidate = `${base}-${suffix}`;
  used.add(candidate);
  return candidate;
}

export function normalizeAlias(raw: string): string {
  const withoutGguf = raw.replace(/\.gguf$/i, "");
  const alias = withoutGguf
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (!alias) throw new Error("The model alias is empty after normalization.");
  return alias;
}
