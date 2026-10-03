import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { isEnoent } from "../campaign/fs_util.ts";
import { PLAYER_SHEET_MD, SEED_MD } from "../campaign/paths.ts";
import type { SeedPackCard } from "./types.ts";

export function defaultPacksDir(): string {
  return path.resolve(import.meta.dir, "../../packs");
}

export function titleCaseFolder(folder: string): string {
  return folder
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function listSeedPacks(
  packsDir: string = defaultPacksDir(),
): Promise<SeedPackCard[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(packsDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const cards: SeedPackCard[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packsDir, entry.name);
    if (!(await isValidPack(dir))) continue;
    cards.push(await readPackCard(dir, entry.name));
  }
  cards.sort((a, b) => a.name.localeCompare(b.name));
  return cards;
}

async function isValidPack(dir: string): Promise<boolean> {
  for (const req of [SEED_MD, PLAYER_SHEET_MD] as const) {
    try {
      const st = await stat(path.join(dir, req));
      if (!st.isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function readPackCard(dir: string, folder: string): Promise<SeedPackCard> {
  const fallback = titleCaseFolder(folder);
  let name = fallback;
  let description: string | undefined;
  try {
    const raw = await readFile(path.join(dir, "pack.yaml"), "utf8");
    const parsed: unknown = parseYaml(raw);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.name === "string" && obj.name.trim()) name = obj.name.trim();
      if (typeof obj.description === "string" && obj.description.trim()) {
        description = obj.description.trim().replace(/\s+/g, " ");
      }
    }
  } catch {
    // Author meta is optional; a broken pack.yaml must not hide the pack.
  }
  return { id: folder, dir, name, description };
}
