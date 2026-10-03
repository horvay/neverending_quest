/**
 * Atomic builds on disk: the release archive NQ downloads and verifies from
 * GitHub, the build `nq local install` chose for this machine, and the builds
 * downloaded beside it for cards that one cannot reach (Vulkan for an Intel
 * Arc next to a CUDA card). Each build lists the cards it sees, and a chosen
 * card is found again in that list by name when the engine launches.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { downloadVerified } from "../download.ts";
import { fileExists } from "../files.ts";
import type { LocalInstallation, LocalProgress } from "../installation.ts";
import type { LocalFetch } from "../model_source.ts";
import type { EngineContext } from "./engine.ts";
import type { LocalGpu, LocalGpuChoice, LocalGpuList } from "../profile.ts";
import {
  selectLocalRuntimeTarget,
  supportedLocalBackends,
  type LocalBackend,
  type LocalRuntimeTarget,
} from "../target.ts";

export const DEFAULT_ATOMIC_RELEASE = "b10269-1.5.1";

type Backend = Exclude<LocalBackend, "auto">;

/**
 * Vulkan reaches every vendor's card and its build is small, so it is the one
 * NQ offers beside whichever build `install` chose.
 */
const EXTRA_GPU_BACKENDS: readonly Backend[] = ["vulkan"];

export type AtomicBuild = { backend: Backend; serverPath: string };

type ReleaseAsset = {
  name: string;
  url: string;
  sha256: string;
  size?: number;
};

class AtomicReleaseNotFoundError extends Error {}

function atomicServerName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "llama-server.exe" : "llama-server";
}

function buildServerPath(
  ctx: EngineContext,
  release: string,
  backend: Backend,
): string {
  return path.join(
    ctx.rootDir,
    "runtime",
    release,
    backend,
    "build",
    "bin",
    atomicServerName(ctx.platform),
  );
}

/**
 * Where a build beside the installed one comes from: the installed release,
 * so both builds are the same Atomic, or the default release when the
 * installed one was built locally and GitHub has no such tag.
 */
function sideBuildReleases(installation: LocalInstallation): string[] {
  return [...new Set([installation.runtime.release, DEFAULT_ATOMIC_RELEASE])];
}

/** A build downloaded beside the installed one, if there is one. */
async function findSideBuild(
  ctx: EngineContext,
  installation: LocalInstallation,
  backend: Backend,
): Promise<string | undefined> {
  for (const release of sideBuildReleases(installation)) {
    const serverPath = buildServerPath(ctx, release, backend);
    if (await fileExists(serverPath)) return serverPath;
  }
  return undefined;
}

/**
 * The installed build first, then the ones NQ downloads beside it. Other
 * builds left on disk by an earlier install are not the player's choice and
 * would list the same card twice.
 */
export async function installedAtomicBuilds(
  ctx: EngineContext,
  installation: LocalInstallation,
): Promise<AtomicBuild[]> {
  const primary = installation.runtime.target.backend;
  const builds: AtomicBuild[] = [
    { backend: primary, serverPath: installation.runtime.serverPath },
  ];
  const supported = supportedLocalBackends(ctx.platform, ctx.arch);
  for (const backend of EXTRA_GPU_BACKENDS) {
    if (backend === primary || !supported.includes(backend)) continue;
    const serverPath = await findSideBuild(ctx, installation, backend);
    if (serverPath) builds.push({ backend, serverPath });
  }
  return builds;
}

/** Every card the downloaded builds can run on, and the builds still on offer. */
export async function listAtomicGpus(
  ctx: EngineContext,
  installation: LocalInstallation,
): Promise<LocalGpuList> {
  const builds = await installedAtomicBuilds(ctx, installation);
  const gpus: LocalGpu[] = [];
  for (const build of builds) {
    gpus.push(
      ...parseDeviceList(await queryDevices(build.serverPath), build.backend),
    );
  }
  const supported = supportedLocalBackends(ctx.platform, ctx.arch);
  return {
    gpus,
    primaryBackend: installation.runtime.target.backend,
    downloadable: EXTRA_GPU_BACKENDS.filter(
      (backend) =>
        supported.includes(backend) &&
        !builds.some((build) => build.backend === backend),
    ),
  };
}

/**
 * The build and `--device` for a chosen card. Device numbers follow driver
 * enumeration, which shifts when a driver is added or removed, so the card
 * is found again by name and its number taken from the build's own list.
 */
export async function resolveAtomicGpu(
  ctx: EngineContext,
  installation: LocalInstallation,
  gpu: LocalGpuChoice | undefined,
): Promise<{ serverPath: string; args: string[] }> {
  if (!gpu) return { serverPath: installation.runtime.serverPath, args: [] };
  const serverPath =
    gpu.backend === installation.runtime.target.backend
      ? installation.runtime.serverPath
      : await findSideBuild(ctx, installation, gpu.backend);
  if (!serverPath || !(await fileExists(serverPath))) {
    throw new Error(
      `The ${gpu.backend} engine for ${gpu.name} is not downloaded. Download it on the load page, or choose another GPU.`,
    );
  }
  const listed = parseDeviceList(await queryDevices(serverPath), gpu.backend);
  const match =
    listed.find(
      (candidate) =>
        candidate.device === gpu.device && candidate.name === gpu.name,
    ) ?? listed.find((candidate) => candidate.name === gpu.name);
  if (!match) {
    throw new Error(
      `${gpu.name} is not available to the ${gpu.backend} engine. Check its driver, or choose another GPU.`,
    );
  }
  return { serverPath, args: ["--device", match.device] };
}

/**
 * Downloads another build beside the installed one, for a card the installed
 * build cannot reach. Nothing happens when that build is already there.
 */
export async function downloadSideBuild(
  ctx: EngineContext,
  installation: LocalInstallation,
  backend: Backend,
  opts: {
    onProgress?: (progress: LocalProgress) => void;
    beforeReplace?: (buildRoot: string) => Promise<void>;
  } = {},
): Promise<void> {
  if (backend === installation.runtime.target.backend) return;
  if (await findSideBuild(ctx, installation, backend)) return;
  // an explicit backend never consults the hardware
  const target = selectLocalRuntimeTarget(
    ctx.platform,
    ctx.arch,
    { rocm: false, vulkan: false },
    backend,
  );
  const releases = sideBuildReleases(installation);
  for (const [index, release] of releases.entries()) {
    try {
      await downloadAtomicBuild(ctx, { release, target, ...opts });
      return;
    } catch (error) {
      const last = index === releases.length - 1;
      if (last || !(error instanceof AtomicReleaseNotFoundError)) throw error;
    }
  }
}

/**
 * Downloads, verifies and unpacks one Atomic build under
 * `runtime/<release>/<backend>`, unless `prior` already has it.
 * `beforeReplace` runs before an existing build at that place is replaced, so
 * a server running from it can be stopped first.
 */
export async function downloadAtomicBuild(
  ctx: EngineContext,
  opts: {
    release: string;
    target: LocalRuntimeTarget;
    prior?: LocalInstallation;
    onProgress?: (progress: LocalProgress) => void;
    beforeReplace?: (buildRoot: string) => Promise<void>;
  },
): Promise<LocalInstallation["runtime"]> {
  const { release, target, prior } = opts;
  const progress = opts.onProgress;
  if (
    prior?.runtime.release === release &&
    prior.runtime.target.assetName === target.assetName &&
    (await fileExists(prior.runtime.serverPath))
  ) {
    return prior.runtime;
  }

  const targetRoot = path.join(ctx.rootDir, "runtime", release, target.backend);
  await opts.beforeReplace?.(targetRoot);
  progress?.({
    stage: "resolve",
    message: `Resolving Atomic ${release} for ${target.backend}.`,
  });
  const asset = await resolveReleaseAsset(ctx.fetch, release, target.assetName);
  const staging = path.join(ctx.rootDir, `.staging-${randomUUID()}`);
  const archivePath = path.join(staging, asset.name);
  const extracted = path.join(staging, "extracted");
  try {
    await mkdir(extracted, { recursive: true });
    await downloadVerified(
      ctx.fetch,
      asset.url,
      archivePath,
      asset.sha256,
      asset.size,
      progress,
    );
    progress?.({
      stage: "extract",
      message: `Extracting ${asset.name}.`,
      file: asset.name,
    });
    const extractArgs =
      ctx.platform === "win32"
        ? ["-xf", archivePath, "-C", extracted]
        : ["-xzf", archivePath, "-C", extracted];
    await ctx.runCommand("tar", extractArgs);
    const serverName = atomicServerName(ctx.platform);
    const stagedServer = path.join(extracted, "build", "bin", serverName);
    if (!(await fileExists(stagedServer))) {
      throw new Error(
        `Atomic archive ${asset.name} does not contain build/bin/${serverName}.`,
      );
    }
    if (ctx.platform !== "win32") await chmod(stagedServer, 0o755);
    await mkdir(path.dirname(targetRoot), { recursive: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rename(extracted, targetRoot);
    return {
      release,
      target,
      root: targetRoot,
      serverPath: path.join(targetRoot, "build", "bin", serverName),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function resolveReleaseAsset(
  fetchImpl: LocalFetch,
  release: string,
  assetName: string,
): Promise<ReleaseAsset> {
  const response = await fetchImpl(
    `https://api.github.com/repos/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tags/${encodeURIComponent(release)}`,
    { headers: { accept: "application/vnd.github+json" } },
  );
  if (response.status === 404) {
    throw new AtomicReleaseNotFoundError(
      `Atomic release lookup failed (404) for ${release}.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Atomic release lookup failed (${response.status}) for ${release}.`,
    );
  }
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("assets" in body) ||
    !Array.isArray(body.assets)
  ) {
    throw new Error(`Atomic release ${release} returned invalid metadata.`);
  }
  for (const raw of body.assets) {
    if (!raw || typeof raw !== "object") continue;
    if (!("name" in raw) || raw.name !== assetName) continue;
    const url =
      "browser_download_url" in raw ? raw.browser_download_url : undefined;
    const digest = "digest" in raw ? raw.digest : undefined;
    const size = "size" in raw ? raw.size : undefined;
    if (typeof url !== "string" || typeof digest !== "string") {
      throw new Error(
        `Atomic release asset ${assetName} is missing its URL or digest.`,
      );
    }
    const match = /^sha256:([a-f0-9]{64})$/i.exec(digest);
    if (!match)
      throw new Error(
        `Atomic release asset ${assetName} has no SHA-256 digest.`,
      );
    return {
      name: assetName,
      url,
      sha256: match[1]!.toLowerCase(),
      ...(typeof size === "number" ? { size } : {}),
    };
  }
  throw new Error(`Atomic release ${release} has no ${assetName} asset.`);
}

/**
 * Asks a build which cards it can reach. A build that will not run (a missing
 * driver, a broken download) reaches none, which the list shows as no cards.
 */
async function queryDevices(serverPath: string): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([serverPath, "--list-devices"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
  } catch {
    return "";
  }
  const timer = setTimeout(() => proc.kill(), 20_000);
  try {
    const text = await new Response(proc.stdout as ReadableStream).text();
    await proc.exited;
    return text;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Reads `  Vulkan1: Intel(R) Graphics (BMG G31) (32656 MiB, 31000 MiB free)`. */
function parseDeviceList(text: string, backend: Backend): LocalGpu[] {
  const gpus: LocalGpu[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match =
      /^\s+([A-Za-z][\w-]*?\d+):\s+(.+?)(?:\s+\((\d+) MiB, \d+ MiB free\))?\s*$/.exec(
        line,
      );
    if (!match) continue;
    gpus.push({
      backend,
      device: match[1]!,
      name: match[2]!,
      ...(match[3] ? { memoryMiB: Number(match[3]) } : {}),
    });
  }
  return gpus;
}
