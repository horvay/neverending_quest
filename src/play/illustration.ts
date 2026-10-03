import { readFileSync } from "node:fs";
import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CampaignError } from "../campaign/errors.ts";
import { isEnoent } from "../campaign/fs_util.ts";
import { ILLUSTRATIONS_DIR } from "../campaign/paths.ts";
import { stampTranscriptIllustration } from "../campaign/transcript.ts";

const guide = readFileSync(
  path.join(import.meta.dir, "illustration_guide.md"),
  "utf8",
);

export const ILLUSTRATION_LOOKER_SYSTEM = `You write one Anima prompt for a sitting.

The player sheet and the live *catalog* are pinned. *appearance* is on the catalog. \`read\` a *leaf* when that catalog line has no appearance.

Follow the user guide. Reply with the prompt only.`;

export const ILLUSTRATION_BTW_PREFIX =
  "Follow the prompting guide below. Sheet and live catalog are pinned. Reply with the Anima prompt only.";

export function illustrationFileStem(ts: string): string {
  return ts.replace(/:/g, "-");
}

export function illustrationRel(ts: string): string {
  assertIllustrationTs(ts);
  return path.posix.join(ILLUSTRATIONS_DIR, `${illustrationFileStem(ts)}.png`);
}

export function illustrationAbs(campaignPath: string, ts: string): string {
  assertIllustrationTs(ts);
  return path.join(campaignPath, ILLUSTRATIONS_DIR, `${illustrationFileStem(ts)}.png`);
}

export const ILLUSTRATION_VARIANT_COUNT = 4;

/** Four independent RNG seeds. sd-cli defaults to 42 if `-s` is omitted. */
export function illustrationVariantSeeds(
  random: () => number = Math.random,
): [number, number, number, number] {
  const used = new Set<number>();
  const seeds: number[] = [];
  while (seeds.length < ILLUSTRATION_VARIANT_COUNT) {
    const seed = Math.floor(random() * 0x7fffffff);
    if (used.has(seed)) continue;
    used.add(seed);
    seeds.push(seed);
  }
  return seeds as [number, number, number, number];
}

export function assertIllustrationSlot(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot >= ILLUSTRATION_VARIANT_COUNT) {
    throw new CampaignError("not_found", "Invalid illustration slot");
  }
  return slot;
}

export function illustrationCandidateRel(ts: string, slot: number): string {
  assertIllustrationTs(ts);
  assertIllustrationSlot(slot);
  return path.posix.join(
    ILLUSTRATIONS_DIR,
    `${illustrationFileStem(ts)}-c${slot}.png`,
  );
}

export function illustrationCandidateAbs(
  campaignPath: string,
  ts: string,
  slot: number,
): string {
  assertIllustrationTs(ts);
  assertIllustrationSlot(slot);
  return path.join(
    campaignPath,
    ILLUSTRATIONS_DIR,
    `${illustrationFileStem(ts)}-c${slot}.png`,
  );
}

export async function chooseIllustrationPng(
  campaignPath: string,
  ts: string,
  slot: number,
): Promise<string> {
  const src = illustrationCandidateAbs(campaignPath, ts, slot);
  const dest = illustrationAbs(campaignPath, ts);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(src, dest);
  return illustrationRel(ts);
}

export async function removeIllustrationCandidates(
  campaignPath: string,
  ts: string,
): Promise<void> {
  for (let slot = 0; slot < ILLUSTRATION_VARIANT_COUNT; slot++) {
    const abs = illustrationCandidateAbs(campaignPath, ts, slot);
    try {
      await unlink(abs);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }
}

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function assertIllustrationTs(ts: string): string {
  if (!TS_RE.test(ts) || ts.includes("..") || ts.includes("/") || ts.includes("\\")) {
    throw new CampaignError("not_found", "Invalid illustration id");
  }
  return ts;
}

export function buildIllustrationBtwPrompt(scene: string): string {
  return [
    ILLUSTRATION_BTW_PREFIX,
    "",
    guide.trim(),
    "",
    "Current scene:",
    scene.trim(),
  ].join("\n");
}

function normalizeTag(tag: string): string {
  if (/^score_\d$/.test(tag)) return tag;
  return tag.replace(/_/g, " ");
}

function normalizeTagPrefix(prefix: string): string {
  return prefix
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(normalizeTag)
    .join(", ");
}

export function parseIllustrationPrompt(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  const fence = text.match(/```(?:[a-z]*)?\n?([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();
  text = text
    .replace(/^(prompt|tags)\s*:\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  if (/^(here|i'll|i will|sure|okay)\b/i.test(text)) return null;
  if (text.length > 2400) return null;

  const lines = text
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const first = lines[0]!;
  const rest = lines.slice(1).join(" ").trim();
  const sentenceBreak = text.search(/\.\s+[A-Z]/);
  const restLooksProse = rest.length > 0 && /^[A-Z]/.test(rest);

  let prefix: string;
  let prose: string;
  if (restLooksProse) {
    prefix = normalizeTagPrefix(first);
    prose = rest;
  } else if (sentenceBreak >= 0) {
    prefix = normalizeTagPrefix(text.slice(0, sentenceBreak));
    prose = text.slice(sentenceBreak + 1).trim();
  } else {
    const tags = normalizeTagPrefix(lines.join(", "));
    const parts = tags.split(", ").filter(Boolean);
    if (parts.length < 4) return null;
    return tags;
  }

  const body = prose ? `${prefix}. ${prose.replace(/^\.\s*/, "")}` : prefix;
  const words = body.split(/\s+/).filter(Boolean);
  const commaParts = prefix.split(",").filter((part) => part.trim());
  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0);
  if (commaParts.length < 4 && (sentences.length < 2 || words.length < 16)) {
    return null;
  }
  return body;
}

export async function writeIllustrationPng(
  campaignPath: string,
  ts: string,
  bytes: Uint8Array,
): Promise<string> {
  assertIllustrationTs(ts);
  const abs = illustrationAbs(campaignPath, ts);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return illustrationRel(ts);
}

export async function stampIllustration(
  campaignPath: string,
  ts: string,
  prompt: string,
): Promise<void> {
  await stampTranscriptIllustration(campaignPath, ts, ts, prompt);
}
