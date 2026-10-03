import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  almanacFileText,
  parseAlmanacFile,
  type AlmanacEntry,
} from "./almanac.ts";

/** The player's Almanac entries live beside the config file, as plain JSON. */
export function almanacPath(configPath: string): string {
  return path.join(path.dirname(configPath), "almanac.json");
}

export async function loadAlmanac(configPath: string): Promise<AlmanacEntry[]> {
  let text: string;
  try {
    text = await readFile(almanacPath(configPath), "utf8");
  } catch {
    return [];
  }
  try {
    return parseAlmanacFile(JSON.parse(text));
  } catch {
    // a hand edit that broke the JSON must not stop the Game Master loading
    return [];
  }
}

export async function saveAlmanac(
  configPath: string,
  entries: readonly AlmanacEntry[],
): Promise<void> {
  const target = almanacPath(configPath);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, almanacFileText(entries), "utf8");
  await rename(temp, target);
}
