export type LocalBackend =
  "auto" | "cpu" | "vulkan" | "cuda-12.4" | "cuda-13.3" | "rocm" | "metal";

export type HardwareFacts = {
  nvidia?: {
    driverMajor?: number;
    computeCapability?: number;
  };
  rocm: boolean;
  vulkan: boolean;
};

export type LocalRuntimeTarget = {
  platform: NodeJS.Platform;
  arch: string;
  backend: Exclude<LocalBackend, "auto">;
  assetName: string;
};

const SUPPORTED: Readonly<
  Record<string, readonly Exclude<LocalBackend, "auto">[]>
> = {
  "darwin-arm64": ["metal"],
  "linux-x64": ["cpu", "vulkan", "cuda-12.4", "cuda-13.3", "rocm"],
  "linux-arm64": ["cuda-13.3"],
  "win32-x64": ["cpu", "vulkan", "cuda-12.4", "cuda-13.3"],
};

/** The Atomic builds published for a platform, in no particular order. */
export function supportedLocalBackends(
  platform: NodeJS.Platform,
  arch: string,
): readonly Exclude<LocalBackend, "auto">[] {
  return SUPPORTED[`${platform}-${arch}`] ?? [];
}

export function selectLocalRuntimeTarget(
  platform: NodeJS.Platform,
  arch: string,
  facts: HardwareFacts,
  requested: LocalBackend = "auto",
): LocalRuntimeTarget {
  const key = `${platform}-${arch}`;
  const supported = SUPPORTED[key];
  if (!supported) {
    throw new Error(`Atomic has no supported release for ${platform}/${arch}.`);
  }

  const backend =
    requested === "auto"
      ? chooseAutomaticBackend(platform, arch, facts, supported)
      : requested;
  if (!supported.includes(backend)) {
    throw new Error(
      `Atomic backend ${backend} is unavailable for ${platform}/${arch}. Available: ${supported.join(", ")}.`,
    );
  }

  const platformName =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "macos"
        : "linux";
  const archive = platform === "win32" ? "zip" : "tar.gz";
  const assetBackend = backend === "metal" ? "" : `-${backend}`;
  return {
    platform,
    arch,
    backend,
    assetName: `llama-turboquant-${platformName}-${arch}${assetBackend}.${archive}`,
  };
}

function chooseAutomaticBackend(
  platform: NodeJS.Platform,
  arch: string,
  facts: HardwareFacts,
  supported: readonly Exclude<LocalBackend, "auto">[],
): Exclude<LocalBackend, "auto"> {
  if (platform === "darwin") return "metal";

  if (facts.nvidia) {
    const needsBlackwell = (facts.nvidia.computeCapability ?? 0) >= 12;
    const driverMajor = facts.nvidia.driverMajor ?? 0;
    if (
      needsBlackwell &&
      supported.includes("cuda-13.3") &&
      driverMajor >= 580
    ) {
      return "cuda-13.3";
    }
    if (supported.includes("cuda-12.4") && driverMajor >= 550) {
      return "cuda-12.4";
    }
    if (arch === "arm64" && supported.includes("cuda-13.3")) {
      if (driverMajor < 580) {
        throw new Error(
          "The available Linux arm64 Atomic build requires an NVIDIA 580-series or newer driver.",
        );
      }
      return "cuda-13.3";
    }
  }

  if (facts.rocm && supported.includes("rocm")) return "rocm";
  if (facts.vulkan && supported.includes("vulkan")) return "vulkan";
  if (supported.includes("cpu")) return "cpu";

  throw new Error(
    `No compatible Atomic backend was detected for ${platform}/${arch}. Choose one explicitly with --backend.`,
  );
}

export async function detectHardwareFacts(): Promise<HardwareFacts> {
  const nvidia = await detectNvidia();
  return {
    ...(nvidia ? { nvidia } : {}),
    rocm: await commandSucceeds("rocminfo", ["--version"]),
    vulkan: await commandSucceeds("vulkaninfo", ["--summary"]),
  };
}

async function detectNvidia(): Promise<HardwareFacts["nvidia"] | undefined> {
  const bin = Bun.which("nvidia-smi");
  if (!bin) return undefined;
  try {
    const proc = Bun.spawn(
      [bin, "--query-gpu=driver_version,compute_cap", "--format=csv,noheader"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return {};
    const [driver, capability] = text.trim().split(/\s*,\s*/, 2);
    const driverMajor = Number.parseInt(driver ?? "", 10);
    const computeCapability = Number.parseFloat(capability ?? "");
    return {
      ...(Number.isFinite(driverMajor) ? { driverMajor } : {}),
      ...(Number.isFinite(computeCapability) ? { computeCapability } : {}),
    };
  } catch {
    return {};
  }
}

async function commandSucceeds(
  command: string,
  args: string[],
): Promise<boolean> {
  const bin = Bun.which(command);
  if (!bin) return false;
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
