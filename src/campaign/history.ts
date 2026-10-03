import fs from "node:fs";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import { CampaignError } from "./errors.ts";
import { isEnoent } from "./fs_util.ts";
import {
  DOSSIERS_ARCHIVE_DIR,
  DOSSIERS_DIR,
  GITIGNORE,
  PLAYER_SHEET_MD,
  PLAY_STATE_JSON,
  QUEST_LOG_MD,
  SCRATCH_JSONL,
  ILLUSTRATIONS_IGNORE,
  SESSIONS_IGNORE,
  STORY_BEATS_MD,
  TRANSCRIPT_JSONL,
  TWISTS_MD,
  WORLD_BUILDING_MD,
} from "./paths.ts";

/** Same-size / same-mtime writes fool statusMatrix; compare bytes instead. */
const RACY_FILES = [
  PLAY_STATE_JSON,
  SCRATCH_JSONL,
  TRANSCRIPT_JSONL,
  PLAYER_SHEET_MD,
  WORLD_BUILDING_MD,
  STORY_BEATS_MD,
  QUEST_LOG_MD,
  TWISTS_MD,
];

export const GIT_BRANCH = "main";
export const GIT_AUTHOR = {
  name: "Neverending Quest",
  email: "nq@localhost",
} as const;

function opts(dir: string) {
  return { fs, dir, cache: {} };
}

export async function isCampaignRepo(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

const IGNORE_LINES = [SESSIONS_IGNORE, ILLUSTRATIONS_IGNORE] as const;

export async function ensureGitignore(dir: string): Promise<void> {
  const abs = path.join(dir, GITIGNORE);
  let body = "";
  try {
    body = await readFile(abs, "utf8");
  } catch {
    await writeFile(abs, `${IGNORE_LINES.join("\n")}\n`);
    return;
  }
  const have = new Set(body.split(/\r?\n/).map((line) => line.trim()));
  const missing = IGNORE_LINES.filter((line) => !have.has(line));
  if (missing.length === 0) return;
  const next = body.endsWith("\n") || body.length === 0 ? body : `${body}\n`;
  await writeFile(abs, `${next}${missing.join("\n")}\n`);
}

export async function ensureCampaignGit(
  dir: string,
  message: "birth" | "migrate",
): Promise<string | null> {
  const existed = await isCampaignRepo(dir);
  try {
    if (!existed) {
      await git.init({ ...opts(dir), defaultBranch: GIT_BRANCH });
    }
    await ensureGitignore(dir);
    if (existed && (await hasCommits(dir))) return null;
    return await commitCampaign(dir, message);
  } catch (err) {
    if (err instanceof CampaignError) throw err;
    throw new CampaignError(
      "git_failed",
      `Campaign git ${message} failed at ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function commitCampaign(
  dir: string,
  message: string,
): Promise<string | null> {
  try {
    await ensureGitignore(dir);
    const staged = await stageAll(dir);
    if (!staged) return null;
    return await git.commit({
      ...opts(dir),
      message,
      author: { ...GIT_AUTHOR },
    });
  } catch (err) {
    if (err instanceof CampaignError) throw err;
    throw new CampaignError(
      "git_failed",
      `Campaign commit failed at ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function commitParentOid(
  dir: string,
  oid: string,
): Promise<string | null> {
  try {
    const { commit } = await git.readCommit({ ...opts(dir), oid });
    return commit.parent[0] ?? null;
  } catch {
    return null;
  }
}

export async function rewindCampaign(dir: string, oid: string): Promise<void> {
  try {
    await git.checkout({
      ...opts(dir),
      ref: oid,
      force: true,
      noUpdateHead: true,
    });
    await git.writeRef({
      ...opts(dir),
      ref: `refs/heads/${GIT_BRANCH}`,
      value: oid,
      force: true,
    });
    await git.writeRef({
      ...opts(dir),
      ref: "HEAD",
      value: `refs/heads/${GIT_BRANCH}`,
      symbolic: true,
      force: true,
    });
    for (const filepath of await racyFiles(dir)) {
      await restoreFileFromOid(dir, oid, filepath);
    }
  } catch (err) {
    throw new CampaignError(
      "git_failed",
      `Campaign rewind failed at ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Stamped `turn N` / `continue N`; `opening` is turn 0. Newest match wins. */
const STAMPED_TURN = /^(?:turn|continue) (\d+)$/u;

/**
 * Play snapshot whose transcript tip is this GM ts (newest first).
 * Do not use live GM-count as `turn N`: old transcript-only deletes make
 * that number point at an ancient commit.
 */
export async function findPlayCommitForTip(
  dir: string,
  lastGmTs: string,
): Promise<string | null> {
  if (!lastGmTs) return null;
  const log = await listCampaignHistory(dir);
  for (const entry of log) {
    if (
      !STAMPED_TURN.test(entry.message) &&
      entry.message !== "opening" &&
      entry.message !== "turn"
    ) {
      continue;
    }
    if ((await lastGmTsAtCommit(dir, entry.oid)) === lastGmTs) {
      return entry.oid;
    }
  }
  return null;
}

/** Newest `fail` snapshot whose last transcript row is this ts. */
export async function findFailCommitForTip(
  dir: string,
  lastRowTs: string,
): Promise<string | null> {
  if (!lastRowTs) return null;
  const log = await listCampaignHistory(dir);
  for (const entry of log) {
    if (entry.message !== "fail") continue;
    if ((await lastRowTsAtCommit(dir, entry.oid)) === lastRowTs) {
      return entry.oid;
    }
  }
  return null;
}

async function lastGmTsAtCommit(
  dir: string,
  oid: string,
): Promise<string | null> {
  return lastTranscriptTsAtCommit(dir, oid, "gm");
}

async function lastRowTsAtCommit(
  dir: string,
  oid: string,
): Promise<string | null> {
  return lastTranscriptTsAtCommit(dir, oid, null);
}

async function lastTranscriptTsAtCommit(
  dir: string,
  oid: string,
  role: "gm" | null,
): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({
      ...opts(dir),
      oid,
      filepath: TRANSCRIPT_JSONL,
    });
    const raw = new TextDecoder().decode(blob);
    let tip: string | null = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") continue;
      const rec = parsed as { role?: unknown; ts?: unknown };
      if (typeof rec.ts !== "string") continue;
      if (role !== null && rec.role !== role) continue;
      tip = rec.ts;
    }
    return tip;
  } catch {
    return null;
  }
}

/**
 * Snapshot Continue lands on. Prefer stamped messages so turn N is not
 * inferred from commit time. Unstamped `turn` (oldest→newest) is fallback.
 */
export async function findTurnCommit(
  dir: string,
  turn: number,
): Promise<string | null> {
  if (!Number.isInteger(turn) || turn < 0) return null;
  const log = await listCampaignHistory(dir);
  for (const entry of log) {
    if (turn === 0 && entry.message === "opening") return entry.oid;
    const stamped = STAMPED_TURN.exec(entry.message);
    if (stamped && Number(stamped[1]) === turn) return entry.oid;
  }
  if (turn === 0) return null;
  let n = 0;
  for (const entry of [...log].reverse()) {
    if (entry.message === "turn") {
      n += 1;
      if (n === turn) return entry.oid;
    }
  }
  return null;
}

export async function listCampaignHistory(dir: string): Promise<
  Array<{ oid: string; message: string }>
> {
  try {
    const log = await git.log({ ...opts(dir) });
    return log.map((e) => ({
      oid: e.oid,
      message: e.commit.message.replace(/\n+$/u, ""),
    }));
  } catch (err) {
    throw new CampaignError(
      "git_failed",
      `Campaign history failed at ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function listTrackedFiles(dir: string): Promise<string[]> {
  return git.listFiles({ ...opts(dir) });
}

async function hasCommits(dir: string): Promise<boolean> {
  try {
    await git.log({ ...opts(dir), depth: 1 });
    return true;
  } catch {
    return false;
  }
}

async function racyFiles(dir: string): Promise<string[]> {
  const files = [...RACY_FILES];
  try {
    const names = await readdir(path.join(dir, DOSSIERS_DIR));
    for (const name of names) {
      if (/^[a-z0-9-]+\.md$/.test(name)) {
        files.push(`${DOSSIERS_DIR}/${name}`);
      }
    }
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  try {
    const names = await readdir(path.join(dir, DOSSIERS_ARCHIVE_DIR));
    for (const name of names) {
      if (/^[a-z0-9-]+\.md$/.test(name)) {
        files.push(`${DOSSIERS_ARCHIVE_DIR}/${name}`);
      }
    }
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  return files;
}

async function stageAll(dir: string): Promise<boolean> {
  let dirty = false;
  for (const filepath of await racyFiles(dir)) {
    if (await stageIfBytesChanged(dir, filepath)) dirty = true;
  }
  const matrix = await git.statusMatrix({ ...opts(dir) });
  for (const [filepath, head, workdir, stage] of matrix) {
    if (head === workdir && workdir === stage) continue;
    dirty = true;
    if (workdir === 0) {
      await git.remove({ ...opts(dir), filepath });
    } else {
      await git.add({ ...opts(dir), filepath });
    }
  }
  return dirty;
}

async function stageIfBytesChanged(
  dir: string,
  filepath: string,
): Promise<boolean> {
  const abs = path.join(dir, filepath);
  let work: Uint8Array | null = null;
  try {
    work = new Uint8Array(await readFile(abs));
  } catch {
    work = null;
  }
  let head: Uint8Array | null = null;
  try {
    const headOid = await git.resolveRef({ ...opts(dir), ref: "HEAD" });
    const { blob } = await git.readBlob({
      ...opts(dir),
      oid: headOid,
      filepath,
    });
    head = blob;
  } catch {
    head = null;
  }
  if (work === null && head === null) return false;
  if (work === null) {
    await git.remove({ ...opts(dir), filepath });
    return true;
  }
  if (head !== null && bytesEqual(work, head)) return false;
  await git.add({ ...opts(dir), filepath });
  return true;
}

async function restoreFileFromOid(
  dir: string,
  oid: string,
  filepath: string,
): Promise<void> {
  const abs = path.join(dir, filepath);
  try {
    const { blob } = await git.readBlob({ ...opts(dir), oid, filepath });
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, blob);
  } catch {
    await rm(abs, { force: true });
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
