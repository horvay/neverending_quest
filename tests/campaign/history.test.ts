import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import {
  commitCampaign,
  ensureCampaignGit,
  findFailCommitForTip,
  findTurnCommit,
  GIT_AUTHOR,
  GITIGNORE,
  isCampaignRepo,
  listCampaignHistory,
  listTrackedFiles,
  newCampaign,
  openCampaign,
  PLAYER_SHEET_MD,
  rewindCampaign,
  SESSIONS_DIR,
  TRANSCRIPT_JSONL,
} from "../../src/campaign/index.ts";
import {
  makeTempDir,
  readText,
  rmTempDir,
  writePack,
} from "../helpers/fs.ts";

async function commitDated(
  dir: string,
  message: string,
  timestamp: number,
): Promise<string> {
  await git.add({ fs, dir, filepath: PLAYER_SHEET_MD });
  return git.commit({
    fs,
    dir,
    message,
    author: { ...GIT_AUTHOR, timestamp, timezoneOffset: 0 },
  });
}

async function birth(root: string): Promise<string> {
  const pack = path.join(root, "pack");
  const campaign = path.join(root, "camp");
  await writePack(pack, {
    "seed.md": "# Premise\nA dock.\n",
    "player_sheet.md":
      "## Description\nRen.\n\n## Inventory\n\n## Powers\n\n## Notes\n",
  });
  await newCampaign({ path: campaign, packDir: pack, name: "Brinewatch" });
  return campaign;
}

describe("Campaign git history", () => {
  test("nq new inits main, gitignore, and a birth commit", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      expect(await isCampaignRepo(campaign)).toBe(true);
      expect(await readText(campaign, GITIGNORE)).toContain(".nq/sessions/");
      expect(await readText(campaign, GITIGNORE)).toContain("illustrations/");

      const log = await listCampaignHistory(campaign);
      expect(log).toHaveLength(1);
      expect(log[0]?.message).toBe("birth");

      const tracked = await listTrackedFiles(campaign);
      expect(tracked).toContain("campaign.yaml");
      expect(tracked).toContain("seed.md");
      expect(tracked).toContain(PLAYER_SHEET_MD);
      expect(tracked).toContain(GITIGNORE);
      expect(tracked.some((f) => f.startsWith(".nq/sessions/"))).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("session journal is not committed", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      const journal = path.join(campaign, SESSIONS_DIR, "omp.jsonl");
      await writeFile(journal, '{"partial":true}\n');
      expect(await commitCampaign(campaign, "should-skip")).toBeNull();
      const tracked = await listTrackedFiles(campaign);
      expect(tracked.some((f) => f.includes("sessions"))).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("commit-if-dirty then rewind restores the tree", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      const before = await listCampaignHistory(campaign);
      const birthOid = before[0]!.oid;

      await writeFile(
        path.join(campaign, PLAYER_SHEET_MD),
        "## Description\nChanged.\n\n## Inventory\n\n## Powers\n\n## Notes\n",
      );
      const oid = await commitCampaign(campaign, "edit-sheet");
      expect(oid).toBeTruthy();
      expect(await listCampaignHistory(campaign)).toHaveLength(2);
      expect(await readText(campaign, PLAYER_SHEET_MD)).toContain("Changed.");

      await rewindCampaign(campaign, birthOid);
      expect(await readText(campaign, PLAYER_SHEET_MD)).toContain("Ren.");
      const after = await listCampaignHistory(campaign);
      expect(after).toHaveLength(1);
      expect(after[0]?.oid).toBe(birthOid);
    } finally {
      await rmTempDir(root);
    }
  });

  test("clean tree skips a second commit", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      expect(await commitCampaign(campaign, "noop")).toBeNull();
      expect(await listCampaignHistory(campaign)).toHaveLength(1);
    } finally {
      await rmTempDir(root);
    }
  });

  test("open migrates a Campaign folder that has no .git", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      await rm(path.join(campaign, ".git"), { recursive: true, force: true });
      expect(await isCampaignRepo(campaign)).toBe(false);

      await openCampaign(campaign);
      expect(await isCampaignRepo(campaign)).toBe(true);
      const log = await listCampaignHistory(campaign);
      expect(log).toHaveLength(1);
      expect(log[0]?.message).toBe("migrate");
    } finally {
      await rmTempDir(root);
    }
  });

  test("open of an already-inited Campaign does not add a commit", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      await writeFile(
        path.join(campaign, PLAYER_SHEET_MD),
        "## Description\nDirty.\n\n## Inventory\n\n## Powers\n\n## Notes\n",
      );
      await openCampaign(campaign);
      expect(await listCampaignHistory(campaign)).toHaveLength(1);
      expect(await readText(campaign, PLAYER_SHEET_MD)).toContain("Dirty.");
    } finally {
      await rmTempDir(root);
    }
  });

  test("play_state and scratch are tracked when present", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      await mkdir(path.join(campaign, ".nq"), { recursive: true });
      await writeFile(
        path.join(campaign, ".nq/play_state.json"),
        `${JSON.stringify({ success_turn_count: 3 }, null, 2)}\n`,
      );
      await writeFile(
        path.join(campaign, ".nq/scratch.jsonl"),
        `${JSON.stringify({ ts: "t", turn: 1, thinking: "", tools: [] })}\n`,
      );
      expect(await commitCampaign(campaign, "nq-files")).toBeTruthy();
      const tracked = await listTrackedFiles(campaign);
      expect(tracked).toContain(".nq/play_state.json");
      expect(tracked).toContain(".nq/scratch.jsonl");
    } finally {
      await rmTempDir(root);
    }
  });

  test("same-size play_state writes still commit and rewind restores the count", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      await mkdir(path.join(campaign, ".nq"), { recursive: true });
      await writeFile(
        path.join(campaign, ".nq/play_state.json"),
        `${JSON.stringify({ success_turn_count: 1 }, null, 2)}\n`,
      );
      const first = await commitCampaign(campaign, "turn 1");
      await writeFile(
        path.join(campaign, ".nq/play_state.json"),
        `${JSON.stringify({ success_turn_count: 2 }, null, 2)}\n`,
      );
      const second = await commitCampaign(campaign, "turn 2");
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
      expect(await readText(campaign, ".nq/play_state.json")).toContain(
        '"success_turn_count": 2',
      );

      await rewindCampaign(campaign, first!);
      expect(await readText(campaign, ".nq/play_state.json")).toContain(
        '"success_turn_count": 1',
      );
    } finally {
      await rmTempDir(root);
    }
  });

  test("same-size player_sheet rewrite still commits", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      const firstBody = "## Description\nRen Caldew.\n";
      const secondBody = "## Description\nRen CALDEW.\n";
      expect(firstBody.length).toBe(secondBody.length);
      await writeFile(path.join(campaign, PLAYER_SHEET_MD), firstBody);
      const first = await commitCampaign(campaign, "inspect");
      expect(first).toBeTruthy();
      await writeFile(path.join(campaign, PLAYER_SHEET_MD), secondBody);
      const second = await commitCampaign(campaign, "inspect");
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
      expect(await readText(campaign, PLAYER_SHEET_MD)).toBe(secondBody);

      await rewindCampaign(campaign, first!);
      expect(await readText(campaign, PLAYER_SHEET_MD)).toBe(firstBody);
    } finally {
      await rmTempDir(root);
    }
  });

  test("findTurnCommit uses stamped messages, not commit order by clock", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      await writeFile(path.join(campaign, PLAYER_SHEET_MD), "opening-sheet\n");
      const opening = await commitDated(campaign, "opening", 2_000_000_000);
      await writeFile(path.join(campaign, PLAYER_SHEET_MD), "turn-one\n");
      const turn1 = await commitDated(campaign, "turn 1", 3_000_000_000);
      await writeFile(path.join(campaign, PLAYER_SHEET_MD), "turn-two\n");
      const turn2 = await commitDated(campaign, "turn 2", 4_000_000_000);
      await writeFile(path.join(campaign, PLAYER_SHEET_MD), "continue-one\n");
      const cont1 = await commitDated(campaign, "continue 1", 1);
      expect(opening).toBeTruthy();
      expect(await findTurnCommit(campaign, 0)).toBe(opening);
      expect(await findTurnCommit(campaign, 1)).toBe(cont1);
      expect(await findTurnCommit(campaign, 2)).toBe(turn2);
      expect(await findTurnCommit(campaign, 3)).toBeNull();
      expect(turn1).not.toBe(cont1);
      const log = await git.log({ fs, dir: campaign });
      const contEntry = log.find((e) => e.oid === cont1);
      const turn1Entry = log.find((e) => e.oid === turn1);
      expect(contEntry!.commit.author.timestamp).toBeLessThan(
        turn1Entry!.commit.author.timestamp,
      );
    } finally {
      await rmTempDir(root);
    }
  });

  test("findFailCommitForTip matches newest fail whose last row is the ts", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      const playerTs = "2026-08-18T04:20:00.000Z";
      await mkdir(path.join(campaign, ".nq"), { recursive: true });
      await writeFile(
        path.join(campaign, TRANSCRIPT_JSONL),
        `${JSON.stringify({ ts: "2026-08-18T04:00:00.000Z", role: "gm", text: "open" })}\n`,
      );
      await commitCampaign(campaign, "opening");
      await writeFile(
        path.join(campaign, TRANSCRIPT_JSONL),
        `${JSON.stringify({ ts: "2026-08-18T04:00:00.000Z", role: "gm", text: "open" })}\n${JSON.stringify({ ts: playerTs, role: "player", text: "go" })}\n`,
      );
      const fail = await commitCampaign(campaign, "fail");
      await writeFile(path.join(campaign, PLAYER_SHEET_MD), "inspected\n");
      await commitCampaign(campaign, "inspect");
      expect(await findFailCommitForTip(campaign, playerTs)).toBe(fail);
      expect(await findFailCommitForTip(campaign, "nope")).toBeNull();
    } finally {
      await rmTempDir(root);
    }
  });

  test("findTurnCommit counts unstamped turn commits oldest first", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      await writeFile(path.join(campaign, PLAYER_SHEET_MD), "t1\n");
      const first = await commitCampaign(campaign, "turn");
      await writeFile(path.join(campaign, PLAYER_SHEET_MD), "t2\n");
      const second = await commitCampaign(campaign, "turn");
      expect(await findTurnCommit(campaign, 1)).toBe(first);
      expect(await findTurnCommit(campaign, 2)).toBe(second);
    } finally {
      await rmTempDir(root);
    }
  });

  test("ensureCampaignGit is a no-op birth on an existing repo", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birth(root);
      expect(await ensureCampaignGit(campaign, "birth")).toBeNull();
      expect(await listCampaignHistory(campaign)).toHaveLength(1);
    } finally {
      await rmTempDir(root);
    }
  });
});
