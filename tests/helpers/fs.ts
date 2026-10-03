import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export async function makeTempDir(prefix = "nq-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function rmTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function writePack(
  packDir: string,
  files: Record<string, string>,
): Promise<void> {
  await mkdir(packDir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(packDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }
}

export async function readText(root: string, rel: string): Promise<string> {
  return readFile(path.join(root, rel), "utf8");
}

export async function pathExists(root: string, rel: string): Promise<boolean> {
  try {
    await stat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

export async function listRel(root: string, rel = "."): Promise<string[]> {
  const abs = path.join(root, rel);
  const out: string[] = [];
  async function walk(dir: string, prefix: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), p);
      else out.push(p);
    }
  }
  await walk(abs, rel === "." ? "" : rel);
  return out.sort();
}

export async function readYaml<T>(root: string, rel: string): Promise<T> {
  const text = await readText(root, rel);
  return parseYaml(text) as T;
}
