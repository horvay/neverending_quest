import { readFile, writeFile } from "node:fs/promises";

const TARGET = "node_modules/@oh-my-pi/pi-ai/src/error/flags.ts";
const BEFORE = "service.?unavailable";
const AFTER = "service(?:[ _-]+temporarily)?[ _-]*unavailable";

let source: string;
try {
  source = await readFile(TARGET, "utf8");
} catch {
  process.exit(0);
}

if (source.includes(AFTER)) process.exit(0);

const occurrences = source.split(BEFORE).length - 1;
if (occurrences !== 1) {
  throw new Error(
    `Transient retry patch expected one ${JSON.stringify(BEFORE)} in ${TARGET}, found ${occurrences}`,
  );
}

const patched = source.replace(BEFORE, AFTER);
await writeFile(TARGET, patched);
