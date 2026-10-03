/**
 * Verified downloads: an engine archive or a model file lands under its final
 * name only once its SHA-256 (and size, when known) match.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileExists, safeChildPath } from "./files.ts";
import type { InstalledModelFile, LocalProgress } from "./installation.ts";
import type { LocalFetch, ResolvedModelFile } from "./model_source.ts";

export async function downloadVerified(
  fetchImpl: LocalFetch,
  url: string,
  destination: string,
  expectedSha256: string,
  expectedSize: number | undefined,
  progress: ((progress: LocalProgress) => void) | undefined,
  headers: HeadersInit = {},
): Promise<void> {
  if (await fileExists(destination)) {
    const current = await sha256File(destination);
    if (current === expectedSha256) return;
    await rm(destination, { force: true });
  }

  const partial = `${destination}.partial-${randomUUID()}`;
  await mkdir(path.dirname(destination), { recursive: true });
  progress?.({
    stage: "download",
    message: `Downloading ${path.basename(destination)}.`,
    file: path.basename(destination),
    received: 0,
    ...(expectedSize !== undefined ? { total: expectedSize } : {}),
  });
  const response = await fetchImpl(url, { headers, redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}.`);
  }

  const hash = createHash("sha256");
  const sink = Bun.file(partial).writer();
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
      await sink.write(chunk.value);
      received += chunk.value.byteLength;
      progress?.({
        stage: "download",
        message: `Downloading ${path.basename(destination)}.`,
        file: path.basename(destination),
        received,
        ...(expectedSize !== undefined ? { total: expectedSize } : {}),
      });
    }
    await sink.end();
    const actual = hash.digest("hex");
    progress?.({
      stage: "verify",
      message: `Verifying ${path.basename(destination)}.`,
      file: path.basename(destination),
      received,
      ...(expectedSize !== undefined ? { total: expectedSize } : {}),
    });
    if (actual !== expectedSha256) {
      throw new Error(
        `SHA-256 mismatch for ${path.basename(destination)}: expected ${expectedSha256}, got ${actual}.`,
      );
    }
    if (expectedSize !== undefined && received !== expectedSize) {
      throw new Error(
        `Size mismatch for ${path.basename(destination)}: expected ${expectedSize}, got ${received}.`,
      );
    }
    await rename(partial, destination);
  } catch (error) {
    try {
      await sink.end();
    } catch {
      // The writer may already be closed after a stream or verification failure.
    }
    await rm(partial, { force: true });
    throw error;
  }
}

async function sha256File(filename: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(filename).stream();
  const reader = stream.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    hash.update(chunk.value);
  }
  return hash.digest("hex");
}

/**
 * Puts a resolved model's files in place: local files are registered where
 * they are, remote ones downloaded under `models/<source hash>/`. A failure
 * removes the files this call created.
 */
export async function installModelFiles(
  rootDir: string,
  fetchImpl: LocalFetch,
  source: string,
  files: ResolvedModelFile[],
  progress: ((progress: LocalProgress) => void) | undefined,
): Promise<InstalledModelFile[]> {
  const sourceKey = createHash("sha256")
    .update(source)
    .digest("hex")
    .slice(0, 16);
  const modelRoot = path.join(rootDir, "models", sourceKey);
  const installed: InstalledModelFile[] = [];
  const created: string[] = [];
  try {
    for (const file of files) {
      if (file.localPath) {
        installed.push({
          name: file.name,
          path: file.localPath,
          external: true,
          ...(file.size !== undefined ? { size: file.size } : {}),
        });
        continue;
      }
      if (!file.url || !file.sha256) {
        throw new Error(
          `Remote model file ${file.name} is missing its URL or SHA-256 digest.`,
        );
      }
      const destination = safeChildPath(modelRoot, file.name);
      const existed = await fileExists(destination);
      await mkdir(path.dirname(destination), { recursive: true });
      await downloadVerified(
        fetchImpl,
        file.url,
        destination,
        file.sha256,
        file.size,
        progress,
        file.headers,
      );
      if (!existed) created.push(destination);
      installed.push({
        name: file.name,
        path: destination,
        external: false,
        sha256: file.sha256,
        ...(file.size !== undefined ? { size: file.size } : {}),
      });
    }
    return installed;
  } catch (error) {
    for (const filename of created) await rm(filename, { force: true });
    throw error;
  }
}
