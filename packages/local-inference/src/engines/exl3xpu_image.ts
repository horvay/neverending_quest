/**
 * The exl3xpu engine's files: the project's published image
 * (github.com/0xSero/exl3xpu), pulled once from its registry and unpacked
 * into NQ's own folder, patched for Gemma 4. No Docker daemon, no root: the
 * engine later runs from this root filesystem in bubblewrap.
 */
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJsonObject } from "../files.ts";

/** The image NQ runs, pinned by digest so every install unpacks the same bytes. */
export const EXL3XPU_IMAGE = {
  registry: "ghcr.io",
  repository: "0xsero/exl3xpu",
  digest:
    "sha256:21412bdd7535e9c653eeb3d099dce3bc79a83d440def2cd9556111c79c870fa8",
} as const;

/** Bump when the patches below change, so installed engines are re-patched. */
export const EXL3XPU_PATCH_LEVEL = 5;

/**
 * vLLM files NQ takes from its fork (github.com/horvay/vllm, branch main)
 * instead of the image's own: the lazy CPU offloader's Intel copy path, the
 * sliding-window replay slack, Gemma 4 decode-graph capture and the pruned
 * draft vocabulary. Each image file must still be what the image ships at
 * `base` (upstream's, or Intel's own copy for gemma4.py) before it is
 * replaced; each replacement is fetched at `commit` and checked by hash.
 */
export type VllmFork = {
  repository: string;
  base: string;
  commit: string;
  files: ReadonlyArray<{
    path: string;
    baseSha256: string;
    sha256: string;
    /** Earlier fork versions an installed engine may still carry. */
    supersedes?: readonly string[];
  }>;
};

export const EXL3XPU_VLLM_FORK: VllmFork = {
  repository: "horvay/vllm",
  base: "568afb3a13806beb53bb2e6bd518269357b237c0",
  commit: "49eb1dbe80d234ebc7f4a9fd82493ab3a27c311d",
  files: [
    {
      path: "vllm/v1/core/single_type_kv_cache_manager.py",
      baseSha256: "bcb27e38895332bf6a4c55608f2917eb9fd941ec5a629c14b88358f00aadeba8",
      sha256: "cbe2672e465f7c110362846ba56fb2149c8db69ba496c7adab30fbdfab076f63",
    },
    {
      path: "vllm/v1/simple_kv_offload/copy_backend.py",
      baseSha256: "68a40d32b39079846eb68540122c762c1385619c5913b3f64174404e1ee5ee1f",
      sha256: "3ea8996281520dcd1c666ec882f35b36844988e4f0fa1d132cc02719b37de19b",
      supersedes: ["0793687a951896fe4d6b89c992f95c2d1feb613ef92658fc99aff09cbf16362c"],
    },
    {
      path: "vllm/v1/simple_kv_offload/worker.py",
      baseSha256: "19bc6fb2a5dbd71068266e15844c91836b7c79a513974487f6afc24cb4546104",
      sha256: "efb1d3bbc8582a19df6023d8e0b8b518f36d4f04ae205268813a7f3600bc2f6e",
      supersedes: [
        "8e759eca88d406864c210ce198513d63323b74c10814e069c32f1dc2c4a5ed85",
        "1f0e922684d44900eca73dd92648a55cacff024e4e00296740dfc6dda119dc4e",
      ],
    },
    {
      // the image ships Intel's gemma4.py (llm-scaler-vllm), not upstream's
      path: "vllm/model_executor/models/gemma4.py",
      baseSha256: "3c3f24b76440cb68ce84113531e1c43101ee02bb197804ce0475e724501d7a62",
      sha256: "8fe5e21638a768c6cf27dd1a3b38913f9a2f46b718fc38938ee8ecc354b73170",
    },
    {
      path: "vllm/model_executor/models/gemma4_mtp.py",
      baseSha256: "4eee061c81430be28f029ed66360887a57f8711a75c863067d30e3840a488918",
      sha256: "b94f72561f48448725cb7811d3f2f3ab968d4a106ea8c350d8193124950dcfe9",
    },
    {
      path: "vllm/v1/simple_kv_offload/manager.py",
      baseSha256: "256f0b26bca3f16f958dcaf1a1759b11e6f42b02d27ca1fd522f923faeda480b",
      sha256: "c99fb5ce989fa5bdc4c81819ad33fcc2c8a7acafcca3c759ec8120d5454295b1",
    },
  ],
};

/** Where the image's Python packages live; fork paths are relative to it. */
const SITE_PACKAGES = "opt/venv/lib/python3.12/site-packages";

/**
 * Fixes the published image needs for Gemma 4. Each replaces one exact
 * snippet of the image's exl3xpu plugin; an install fails if a snippet is
 * missing rather than run an unpatched engine.
 */
const EXL3XPU_PATCHES: ReadonlyArray<{
  file: string;
  anchor: string;
  replacement: string;
}> = [
  {
    // Gemma 4 attention_k_eq_v layers store no v_proj: vLLM loads every k_proj
    // tensor into the V slot too, so the fused qkv module is uniformly quantized.
    file: "opt/exl3xpu/exl3xpu/vllm_plugin.py",
    anchor: `        bits = [self.storage.get(n) for n in names]
        if all(b is None for b in bits):`,
    replacement: `        bits = [self.storage.get(n) for n in names]
        # NQ: Gemma 4 attention_k_eq_v layers store no v_proj; vLLM loads k_proj into the V slot
        if members == ["q_proj", "k_proj", "v_proj"] and bits[2] is None and bits[1] is not None:
            bits[2] = bits[1]
        if all(b is None for b in bits):`,
  },
  {
    // With tied embeddings vLLM skips every lm_head.* tensor and computes
    // logits from embed_tokens, so an EXL3 lm_head would stay uninitialized.
    file: "opt/exl3xpu/exl3xpu/vllm_plugin.py",
    anchor: `        key = _norm_key(prefix)
        if not self.storage:`,
    replacement: `        key = _norm_key(prefix)
        # NQ: a tied lm_head is never loaded, so leave it unquantized (EXL3_TIED_LM_HEAD=1)
        if key == "lm_head" and os.environ.get("EXL3_TIED_LM_HEAD") == "1":
            return None
        if not self.storage:`,
  },
];

export function exl3xpuRoot(rootDir: string): string {
  return path.join(rootDir, "engines", "exl3xpu");
}

type EngineMarker = { digest: string; patchLevel: number };

/** True when the pinned image is unpacked and patched at the current level. */
export async function exl3xpuInstalled(rootDir: string): Promise<boolean> {
  const marker = (await readJsonObject(
    path.join(exl3xpuRoot(rootDir), "engine.json"),
  )) as Partial<EngineMarker> | undefined;
  return (
    marker?.digest === EXL3XPU_IMAGE.digest &&
    marker.patchLevel === EXL3XPU_PATCH_LEVEL
  );
}

export type Exl3xpuInstallDeps = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  runCommand: (command: string, args: string[]) => Promise<void>;
  download: (
    url: string,
    destination: string,
    sha256: string,
    size: number | undefined,
    headers: HeadersInit,
  ) => Promise<void>;
  onProgress?: (message: string) => void;
};

/**
 * Pulls the pinned image from its registry and unpacks it layer by layer,
 * honouring OCI whiteouts, then applies NQ's patches and the fork's vLLM files.
 * Layers are downloaded and verified one at a time, so the disk never holds
 * the whole compressed image beside the unpacked one. An engine unpacked from
 * the same image at an older patch level is patched in place instead.
 */
export async function installExl3xpuEngine(
  rootDir: string,
  deps: Exl3xpuInstallDeps,
): Promise<void> {
  if (await exl3xpuInstalled(rootDir)) return;
  const root = exl3xpuRoot(rootDir);
  const marker = (await readJsonObject(path.join(root, "engine.json"))) as
    | Partial<EngineMarker>
    | undefined;
  const installedRootfs = path.join(root, "rootfs");
  if (
    marker?.digest === EXL3XPU_IMAGE.digest &&
    (await stat(path.join(installedRootfs, SITE_PACKAGES)).catch(() => undefined))
  ) {
    deps.onProgress?.("Updating the exl3xpu engine.");
    const scratch = path.join(root, `.update-${process.pid}`);
    try {
      await patchEngine(installedRootfs);
      await overlayVllmFork(installedRootfs, scratch, deps);
      await writeMarker(root);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    return;
  }
  const staging = path.join(root, `.staging-${process.pid}`);
  const rootfs = path.join(staging, "rootfs");
  await rm(staging, { recursive: true, force: true });
  await mkdir(rootfs, { recursive: true });
  try {
    const { registry, repository, digest } = EXL3XPU_IMAGE;
    const base = `https://${registry}/v2/${repository}`;
    const token = await registryToken(deps, registry, repository);
    const auth = { authorization: `Bearer ${token}` };
    const accept = [
      "application/vnd.oci.image.index.v1+json",
      "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.docker.distribution.manifest.list.v2+json",
      "application/vnd.docker.distribution.manifest.v2+json",
    ].join(", ");
    let manifest = await fetchJson(deps, `${base}/manifests/${digest}`, {
      ...auth,
      accept,
    });
    if (Array.isArray(manifest.manifests)) {
      const entry = (manifest.manifests as Array<Record<string, unknown>>).find(
        (candidate) => {
          const platform = candidate.platform as Record<string, unknown> | undefined;
          return platform?.os === "linux" && platform.architecture === "amd64";
        },
      );
      if (!entry || typeof entry.digest !== "string") {
        throw new Error("The exl3xpu image has no linux/amd64 manifest.");
      }
      manifest = await fetchJson(deps, `${base}/manifests/${entry.digest}`, {
        ...auth,
        accept,
      });
    }
    const layers = (manifest.layers ?? []) as Array<Record<string, unknown>>;
    if (layers.length === 0) throw new Error("The exl3xpu image lists no layers.");
    for (const [index, layer] of layers.entries()) {
      const layerDigest = String(layer.digest ?? "");
      const match = /^sha256:([a-f0-9]{64})$/.exec(layerDigest);
      if (!match) throw new Error(`exl3xpu layer ${index + 1} has no SHA-256 digest.`);
      if (!/tar\+gzip|tar\.gzip|diff\.tar\.gzip/.test(String(layer.mediaType ?? ""))) {
        throw new Error(`exl3xpu layer ${index + 1} is not a gzip tar (${layer.mediaType}).`);
      }
      deps.onProgress?.(`Downloading the exl3xpu engine: layer ${index + 1} of ${layers.length}.`);
      const archive = path.join(staging, `layer-${index}.tar.gz`);
      await deps.download(
        `${base}/blobs/${layerDigest}`,
        archive,
        match[1]!,
        typeof layer.size === "number" ? layer.size : undefined,
        auth,
      );
      deps.onProgress?.(`Unpacking the exl3xpu engine: layer ${index + 1} of ${layers.length}.`);
      const unpacked = path.join(staging, `layer-${index}`);
      await mkdir(unpacked, { recursive: true });
      // device nodes need root and nothing in the engine opens them from the image
      await deps.runCommand("tar", [
        "-xzf",
        archive,
        "-C",
        unpacked,
        "--no-same-owner",
        "--exclude=dev/*",
      ]);
      await rm(archive, { force: true });
      await applyLayer(unpacked, rootfs);
      await rm(unpacked, { recursive: true, force: true });
    }
    await patchEngine(rootfs);
    await overlayVllmFork(rootfs, staging, deps);
    await rm(path.join(root, "rootfs"), { recursive: true, force: true });
    await rename(rootfs, path.join(root, "rootfs"));
    await writeMarker(root);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function writeMarker(root: string): Promise<void> {
  const marker: EngineMarker = {
    digest: EXL3XPU_IMAGE.digest,
    patchLevel: EXL3XPU_PATCH_LEVEL,
  };
  await writeFile(path.join(root, "engine.json"), `${JSON.stringify(marker)}\n`);
}

/**
 * Replaces the image's copies of the fork's vLLM files. A file already at the
 * fork's hash is left alone, and upstream's base or an earlier fork version is
 * replaced; anything else fails the install, so a changed image is never run
 * with half its vLLM swapped.
 */
async function overlayVllmFork(
  rootfs: string,
  scratch: string,
  deps: Exl3xpuInstallDeps,
): Promise<void> {
  const fork = EXL3XPU_VLLM_FORK;
  const pending: Array<{ target: string; url: string; sha256: string }> = [];
  for (const file of fork.files) {
    const target = path.join(rootfs, SITE_PACKAGES, file.path);
    const current = await sha256File(target).catch(() => {
      throw new Error(`The exl3xpu image has no ${file.path} to replace.`);
    });
    if (current === file.sha256) continue;
    if (current !== file.baseSha256 && !file.supersedes?.includes(current)) {
      throw new Error(
        `The exl3xpu image's ${file.path} is not the copy built from vLLM ${fork.base.slice(0, 9)}; update EXL3XPU_VLLM_FORK.`,
      );
    }
    pending.push({
      target,
      url: `https://raw.githubusercontent.com/${fork.repository}/${fork.commit}/${file.path}`,
      sha256: file.sha256,
    });
  }
  if (pending.length === 0) return;
  deps.onProgress?.(`Fetching NQ's vLLM changes (${fork.repository} ${fork.commit.slice(0, 7)}).`);
  // every file is verified before any replaces its original
  await mkdir(scratch, { recursive: true });
  const fetched: Array<{ target: string; downloaded: string }> = [];
  for (const [index, file] of pending.entries()) {
    const downloaded = path.join(scratch, `vllm-fork-${index}.py`);
    await deps.download(file.url, downloaded, file.sha256, undefined, {});
    fetched.push({ target: file.target, downloaded });
  }
  for (const { target, downloaded } of fetched) {
    await rename(downloaded, target);
  }
}

async function sha256File(filename: string): Promise<string> {
  const bytes = await readFile(filename);
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function registryToken(
  deps: Exl3xpuInstallDeps,
  registry: string,
  repository: string,
): Promise<string> {
  const body = await fetchJson(
    deps,
    `https://${registry}/token?scope=repository:${repository}:pull`,
    {},
  );
  if (typeof body.token !== "string") {
    throw new Error(`${registry} returned no pull token for ${repository}.`);
  }
  return body.token;
}

async function fetchJson(
  deps: Exl3xpuInstallDeps,
  url: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await deps.fetch(url, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`exl3xpu image request failed (${response.status}) for ${url}.`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") {
    throw new Error(`exl3xpu image request returned no JSON for ${url}.`);
  }
  return body as Record<string, unknown>;
}

/**
 * Moves one unpacked layer onto the root filesystem. OCI whiteouts delete what
 * lower layers left: `.wh.<name>` removes that entry, and `.wh..wh..opq` empties
 * its directory before this layer's own entries land.
 */
async function applyLayer(layer: string, rootfs: string): Promise<void> {
  const entries = await readdir(layer, { withFileTypes: true });
  if (entries.some((entry) => entry.name === ".wh..wh..opq")) {
    for (const existing of await readdir(rootfs).catch(() => [])) {
      await rm(path.join(rootfs, existing), { recursive: true, force: true });
    }
  }
  for (const entry of entries) {
    if (entry.name === ".wh..wh..opq") continue;
    if (entry.name.startsWith(".wh.")) {
      await rm(path.join(rootfs, entry.name.slice(4)), {
        recursive: true,
        force: true,
      });
      continue;
    }
    const source = path.join(layer, entry.name);
    const target = path.join(rootfs, entry.name);
    const existing = await stat(target).catch(() => undefined);
    const targetIsDir =
      existing?.isDirectory() === true &&
      !(await isSymlink(target));
    if (entry.isDirectory() && targetIsDir) {
      await applyLayer(source, target);
      continue;
    }
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await rename(source, target);
  }
}

async function isSymlink(filename: string): Promise<boolean> {
  return (await lstat(filename).catch(() => undefined))?.isSymbolicLink() === true;
}

async function patchEngine(rootfs: string): Promise<void> {
  for (const patch of EXL3XPU_PATCHES) {
    const filename = path.join(rootfs, patch.file);
    const source = await readFile(filename, "utf8").catch(() => {
      throw new Error(`The exl3xpu image has no ${patch.file} to patch.`);
    });
    if (source.includes(patch.replacement)) continue;
    if (!source.includes(patch.anchor)) {
      throw new Error(
        `The exl3xpu image's ${patch.file} no longer matches NQ's patch; update EXL3XPU_PATCHES.`,
      );
    }
    await writeFile(filename, source.replace(patch.anchor, patch.replacement));
  }
}
