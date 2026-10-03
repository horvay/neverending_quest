/**
 * The runtime's two records on disk, under the local root:
 *
 * - `installation.json`: the installed Atomic build and the registered
 *   models (schema 2; a schema 1 single-model file is migrated on read);
 * - `run.json`: the engine process NQ started, while it runs.
 */
import { type } from "@oh-my-pi/pi-ai";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { errorMessage, isMissingFileError, writeJsonAtomic } from "./files.ts";
import type { LocalRuntimeTarget } from "./target.ts";

export type LocalProgress = {
  stage:
    | "detect"
    | "resolve"
    | "download"
    | "verify"
    | "extract"
    | "configure"
    | "start";
  message: string;
  file?: string;
  received?: number;
  total?: number;
};

export type InstalledModelFile = {
  name: string;
  path: string;
  external: boolean;
  sha256?: string;
  size?: number;
};

export type InstalledLocalModel = {
  alias: string;
  source: string;
  files: InstalledModelFile[];
  primaryPath: string;
  mtp?: InstalledModelFile;
  /** multimodal projector, loaded with -mmproj so the model can see images */
  mmproj?: InstalledModelFile;
  /**
   * An EXL3 model folder, served by the exl3xpu engine instead of Atomic;
   * `primaryPath` is the folder.
   */
  format?: "exl3";
  /** EXL3: an assistant model found for this backbone, used as the drafter. */
  drafter?: InstalledModelFile;
};

export type LocalInstallation = {
  schema: 2;
  runtime: {
    release: string;
    target: LocalRuntimeTarget;
    root: string;
    serverPath: string;
  };
  models: InstalledLocalModel[];
  defaultModel?: string;
  lastPort?: number;
};

const RuntimeTargetSchema = type({
  platform: "'linux' | 'darwin' | 'win32'",
  arch: "string",
  backend: "'cpu' | 'vulkan' | 'cuda-12.4' | 'cuda-13.3' | 'rocm' | 'metal'",
  assetName: "string",
  "+": "reject",
});
const InstalledFileSchema = type({
  name: "string",
  path: "string",
  external: "boolean",
  "sha256?": "string",
  "size?": "number",
  "+": "reject",
});
const InstalledModelSchema = type({
  alias: "string",
  source: "string",
  files: InstalledFileSchema.array(),
  primaryPath: "string",
  "mtp?": InstalledFileSchema,
  "mmproj?": InstalledFileSchema,
  "format?": "'exl3'",
  "drafter?": InstalledFileSchema,
  "+": "reject",
});
const InstallationSchema = type({
  schema: "2",
  runtime: {
    release: "string",
    target: RuntimeTargetSchema,
    root: "string",
    serverPath: "string",
    "+": "reject",
  },
  models: InstalledModelSchema.array(),
  "defaultModel?": "string",
  "lastPort?": "number.integer >= 1 & number.integer <= 65535",
  "+": "reject",
});
const LegacyInstallationSchema = type({
  schema: "1",
  runtime: {
    release: "string",
    target: RuntimeTargetSchema,
    root: "string",
    serverPath: "string",
    "+": "reject",
  },
  "model?": InstalledModelSchema,
  "lastPort?": "number.integer >= 1 & number.integer <= 65535",
  "+": "reject",
});
const RunRecordSchema = type({
  schema: "1",
  pid: "number.integer > 0",
  port: "number.integer >= 1 & number.integer <= 65535",
  alias: "string",
  serverPath: "string",
  startedAt: "string",
  "speculative?": "string",
  // absent for Atomic, which is all an older NQ ever wrote
  "engine?": "'atomic' | 'exl3xpu'",
  "+": "reject",
});

/** The engine process NQ started and still owns. */
export type RunRecord = typeof RunRecordSchema.infer;

const INSTALLATION_FILE = "installation.json";
const RUN_FILE = "run.json";

/**
 * `installation.json` as written, a schema 1 file migrated (and saved) to
 * schema 2; undefined when nothing is installed.
 */
export async function readInstallationRecord(
  rootDir: string,
): Promise<LocalInstallation | undefined> {
  const filename = path.join(rootDir, INSTALLATION_FILE);
  try {
    const raw: unknown = JSON.parse(await readFile(filename, "utf8"));
    try {
      return InstallationSchema.assert(raw);
    } catch {
      const legacy = LegacyInstallationSchema.assert(raw);
      const models = legacy.model ? [legacy.model] : [];
      const installation: LocalInstallation = {
        schema: 2,
        runtime: legacy.runtime,
        models,
        ...(legacy.model ? { defaultModel: legacy.model.alias } : {}),
        ...(legacy.lastPort !== undefined ? { lastPort: legacy.lastPort } : {}),
      };
      await writeInstallationRecord(rootDir, installation);
      return installation;
    }
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw new Error(
      `Invalid local runtime state at ${filename}: ${errorMessage(error)}`,
    );
  }
}

export async function writeInstallationRecord(
  rootDir: string,
  installation: LocalInstallation,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeJsonAtomic(path.join(rootDir, INSTALLATION_FILE), installation);
}

export async function readRunRecord(
  rootDir: string,
): Promise<RunRecord | undefined> {
  const filename = path.join(rootDir, RUN_FILE);
  try {
    const raw: unknown = JSON.parse(await readFile(filename, "utf8"));
    return RunRecordSchema.assert(raw);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw new Error(
      `Invalid local server state at ${filename}: ${errorMessage(error)}`,
    );
  }
}

export async function writeRunRecord(
  rootDir: string,
  record: RunRecord,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeJsonAtomic(path.join(rootDir, RUN_FILE), record);
}

export async function clearRunRecord(rootDir: string): Promise<void> {
  await rm(path.join(rootDir, RUN_FILE), { force: true });
}
