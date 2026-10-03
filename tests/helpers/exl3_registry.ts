/**
 * ghcr.io as NQ's exl3xpu pull sees it: a pull token, the pinned image index,
 * its linux/amd64 manifest, and real gzip layer tars, so the runtime's own
 * download, verification, `tar` and whiteout handling all run. The second
 * layer carries a whiteout and an opaque whiteout over the first. The image
 * ships upstream's copies of the vLLM files NQ's fork replaces, and the fork's
 * copies come from a fake raw.githubusercontent.com.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EXL3XPU_IMAGE,
  EXL3XPU_VLLM_FORK,
} from "@nq/local-inference/engines/exl3xpu_image.ts";

/** The two plugin snippets NQ patches, as the published image ships them. */
const PLUGIN_SOURCE = `import os
def _bits_for(self, prefix):
        key = _norm_key(prefix)
        if not self.storage:
            return None
        base, _, leaf = key.rpartition(".")
        bits = [self.storage.get(n) for n in names]
        if all(b is None for b in bits):
            return None
`;

/** Builds a gzip layer tar from `files` (a trailing "/" makes a directory). */
async function layer(root: string, name: string, files: Record<string, string>) {
  const dir = path.join(root, "layers", name);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    if (file.endsWith("/")) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const archive = path.join(root, "layers", `${name}.tar.gz`);
  await Bun.$`tar -czf ${archive} -C ${dir} .`.quiet();
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
  const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
  return { bytes, digest };
}

const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "vllm-fork");

/**
 * The vLLM files NQ's fork replaces, from tests/fixtures/vllm-fork: upstream's
 * copies at the fork's base commit go into the image, and the fork's copies are
 * served at EXL3XPU_VLLM_FORK's pinned raw.githubusercontent.com URLs.
 */
export async function vllmForkFixtures() {
  const site = "opt/venv/lib/python3.12/site-packages";
  const imageFiles: Record<string, string> = {};
  const forkFiles = new Map<string, string>();
  const forkText = new Map<string, string>();
  // what an engine installed with an earlier fork version carries
  const previousText = new Map<string, string>();
  for (const file of EXL3XPU_VLLM_FORK.files) {
    const previous = await readFile(path.join(FIXTURES, "previous", file.path), "utf8").catch(
      () => undefined,
    );
    if (previous !== undefined) previousText.set(file.path, previous);
    imageFiles[`${site}/${file.path}`] = await readFile(path.join(FIXTURES, "base", file.path), "utf8");
    const fork = await readFile(path.join(FIXTURES, "fork", file.path), "utf8");
    forkText.set(file.path, fork);
    forkFiles.set(
      `https://raw.githubusercontent.com/${EXL3XPU_VLLM_FORK.repository}/${EXL3XPU_VLLM_FORK.commit}/${file.path}`,
      fork,
    );
  }
  return { site, imageFiles, forkFiles, forkText, previousText };
}

export async function fakeExl3xpuRegistry(
  root: string,
  opts: { alteredVllmFile?: string } = {},
) {
  const vllm = await vllmForkFixtures();
  if (opts.alteredVllmFile) {
    // an image rebuilt on a different vLLM: one file no longer upstream's base
    vllm.imageFiles[`${vllm.site}/${opts.alteredVllmFile}`] += "# changed upstream\n";
  }
  const base = await layer(root, "base", {
    "opt/exl3xpu/exl3xpu/vllm_plugin.py": PLUGIN_SOURCE,
    "opt/venv/bin/vllm": "#!/bin/sh\n",
    ...vllm.imageFiles,
    "opt/stale/old.txt": "removed by the next layer",
    "etc/cache/a.txt": "cleared by an opaque whiteout",
  });
  const top = await layer(root, "top", {
    "opt/.wh.stale": "",
    "etc/cache/.wh..wh..opq": "",
    "etc/cache/b.txt": "kept",
  });
  const blobs = new Map([base, top].map((entry) => [entry.digest, entry.bytes]));
  const manifestDigest = "sha256:" + "a".repeat(64);
  const requests: string[] = [];
  const repo = `https://${EXL3XPU_IMAGE.registry}/v2/${EXL3XPU_IMAGE.repository}`;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    // raw.githubusercontent.com: the fork's files at its pinned commit
    const forkFile = vllm.forkFiles.get(url);
    if (forkFile !== undefined) return new Response(forkFile);
    const auth = new Headers(init?.headers).get("authorization");
    if (url.startsWith(`https://${EXL3XPU_IMAGE.registry}/token`)) {
      return Response.json({ token: "pull-token" });
    }
    if (auth !== "Bearer pull-token") return new Response("unauthorized", { status: 401 });
    if (url === `${repo}/manifests/${EXL3XPU_IMAGE.digest}`) {
      return Response.json({
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          { digest: "sha256:" + "b".repeat(64), platform: { os: "unknown", architecture: "unknown" } },
          { digest: manifestDigest, platform: { os: "linux", architecture: "amd64" } },
        ],
      });
    }
    if (url === `${repo}/manifests/${manifestDigest}`) {
      return Response.json({
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        layers: [base, top].map((entry) => ({
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
          digest: entry.digest,
          size: entry.bytes.byteLength,
        })),
      });
    }
    const blob = url.startsWith(`${repo}/blobs/`)
      ? blobs.get(url.slice(`${repo}/blobs/`.length))
      : undefined;
    if (blob) return new Response(blob as Uint8Array<ArrayBuffer>);
    return new Response("not found", { status: 404 });
  };
  return { fetch, requests, vllm };
}

