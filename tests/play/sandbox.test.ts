import { describe, expect, test } from "bun:test";
import {
  extractHashlineEditPath,
  extractToolPath,
} from "../../src/play/sandbox.ts";
import path from "node:path";
import {
  createSandbox,
  guardToolCall,
  HYGIENE_TOOL_NAMES,
  PLAY_TOOL_NAMES,
  SandboxError,
  searchFull,
} from "../../src/play/index.ts";
import { archiveDossier } from "../../src/campaign/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";

describe("Campaign Sandbox", () => {
  test("path jail rejects targets outside Campaign root", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const sb = await createSandbox({ campaignRoot: campaign });
      await expect(sb.resolvePath("../outside.txt")).rejects.toBeInstanceOf(
        SandboxError,
      );
      await expect(sb.resolvePath("/etc/passwd")).rejects.toBeInstanceOf(
        SandboxError,
      );
      const inside = await sb.resolvePath("player_sheet.md");
      expect(inside).toBe(path.join(campaign, "player_sheet.md"));
    } finally {
      await rmTempDir(root);
    }
  });

  test("GM tools cannot write transcript, campaign.yaml, or .nq/**", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const sb = await createSandbox({ campaignRoot: campaign });
      expect(await sb.mayWrite("transcript.jsonl")).toBe(false);
      expect(await sb.mayWrite("campaign.yaml")).toBe(false);
      expect(await sb.mayWrite(".nq/play_state.json")).toBe(false);
      expect(await sb.mayWrite("dossier-catalog.md")).toBe(false);
      expect(await sb.mayWrite("player_sheet.md")).toBe(true);
      expect(await sb.mayWrite("dossiers/mira.md")).toBe(true);

      const denied = await guardToolCall(sb, "write", {
        path: "transcript.jsonl",
        content: "nope",
      });
      expect(denied.ok).toBe(false);

      const allowed = await guardToolCall(sb, "write", {
        path: "world-building.md",
        content: "x",
      });
      expect(allowed.ok).toBe(true);

      const catalogRead = await guardToolCall(sb, "read", {
        path: "dossier-catalog.md",
      });
      expect(catalogRead).toEqual({
        ok: false,
        error:
          "dossier-catalog.md is generated prompt context, not a Campaign file. Use dossiers/<slug>.md.",
      });

      await expect(sb.resolvePath(".nq/sessions/x.jsonl")).rejects.toBeInstanceOf(
        SandboxError,
      );
      await expect(
        sb.resolvePath("illustrations/x.png"),
      ).rejects.toBeInstanceOf(SandboxError);
    } finally {
      await rmTempDir(root);
    }
  });

  test("write creates dossiers but cannot replace an existing dossier", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        dossiers: {
          mira:
            "---\nname: Mira\naliases: []\nkind: person\n---\n\n## Quirks\n- Hums while working.\n",
        },
      });
      const sb = await createSandbox({ campaignRoot: campaign });

      expect(
        await guardToolCall(sb, "write", {
          path: "dossiers/mira.md",
          content: "replacement",
        }),
      ).toEqual({
        ok: false,
        error: "Existing dossiers require surgical edits; write only creates a dossier.",
      });
      expect(
        await guardToolCall(sb, "edit", {
          path: "dossiers/mira.md",
          oldText: "Hums",
          newText: "Sings",
        }),
      ).toEqual({ ok: true });
      await archiveDossier(campaign, "mira", true);
      expect(
        await guardToolCall(sb, "write", {
          path: "dossiers/mira.md",
          content: "duplicate",
        }),
      ).toEqual({
        ok: false,
        error: "Existing dossiers require surgical edits; write only creates a dossier.",
      });
      expect(
        await guardToolCall(sb, "write", {
          path: "dossiers/pell.md",
          content: "---\nname: Pell\naliases: []\nkind: person\n---\n",
        }),
      ).toEqual({ ok: true });
    } finally {
      await rmTempDir(root);
    }
  });

  test("roll returns uniform integer in [1,n] and validates n", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      let seq = 0;
      const values = [0, 0.999999, 0.5];
      const sb = await createSandbox({
        campaignRoot: campaign,
        random: () => values[seq++] ?? 0,
      });
      expect(await sb.roll(6)).toBe(1);
      expect(await sb.roll(6)).toBe(6);
      expect(await sb.roll(6)).toBe(4);
      await expect(sb.roll(0)).rejects.toBeInstanceOf(SandboxError);
      await expect(sb.roll(-1)).rejects.toBeInstanceOf(SandboxError);
      await expect(sb.roll(1.5)).rejects.toBeInstanceOf(SandboxError);
    } finally {
      await rmTempDir(root);
    }
  });
  test("roll validation does not spend a pending override", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      let resolved = 0;
      const sb = await createSandbox({
        campaignRoot: campaign,
        resolveRoll: async (n) => {
          resolved += 1;
          return n;
        },
      });

      expect(await guardToolCall(sb, "roll", { n: 20 })).toEqual({ ok: true });
      expect(resolved).toBe(0);
      expect(await sb.roll(20)).toBe(20);
      expect(resolved).toBe(1);
    } finally {
      await rmTempDir(root);
    }
  });


  test("search hits prescribed memory MD, not transcript or .nq", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        world: "The Ash Court watches.\n",
        dossiers: {
          "mira.md": "---\nname: Mira\n---\nKnows the Ash Court secret.\n",
        },
      });
      await Bun.write(path.join(campaign, "transcript.jsonl"), '{"text":"Ash Court"}\n');
      await Bun.write(path.join(campaign, ".nq/secret.md"), "Ash Court hidden\n");

      const sb = await createSandbox({ campaignRoot: campaign });
      const hits = await sb.search("Ash Court");
      expect(hits.some((h) => h.path === "world-building.md")).toBe(true);
      expect(hits.some((h) => h.path.includes("mira"))).toBe(true);
      expect(hits.some((h) => h.path.includes("transcript"))).toBe(false);
      expect(hits.some((h) => h.path.includes(".nq"))).toBe(false);
    } finally {
      await rmTempDir(root);
    }
  });

  test("search reaches the twists leaf", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      await Bun.write(
        path.join(campaign, "twists.md"),
        "- The ferryman already sold the map to the Ash Court.\n",
      );
      const sb = await createSandbox({ campaignRoot: campaign });
      const hits = await sb.search("Ash Court");
      expect(hits.some((h) => h.path === "twists.md")).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });

  test("search hits archived dossiers", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        dossiers: {
          "mira-venn":
            "---\nname: Mira Venn\naliases: []\nkind: person\n---\nInnkeeper.\n",
        },
      });
      await archiveDossier(campaign, "mira-venn", true);
      const sb = await createSandbox({ campaignRoot: campaign });
      const hits = await sb.search("Innkeeper");
      expect(
        hits.some((h) => h.path === "dossiers/archive/mira-venn.md"),
      ).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });

  test("play is read-only while Hygiene owns memory writes", () => {
    expect([...PLAY_TOOL_NAMES]).toEqual([
      "read",
      "roll",
      "search",
      "search_full",
    ]);
    expect([...HYGIENE_TOOL_NAMES]).toEqual([
      "read",
      "edit",
      "write",
      "search",
      "search_full",
      "archive",
    ]);
  });

  test("search_full includes transcript and excludes .nq", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        world: "Ash Court stands.\n",
      });
      await Bun.write(
        path.join(campaign, "transcript.jsonl"),
        `${JSON.stringify({ ts: "t", role: "player", text: "Ash Court rumor" })}\n`,
      );
      await Bun.write(path.join(campaign, ".nq/secret.md"), "Ash Court secret\n");
      const sb = await createSandbox({ campaignRoot: campaign });
      const result = await searchFull(sb, "Ash Court", {
        model: "test-model",
        reasoning: "low",
      });
      expect(result.hits.some((h) => h.path === "world-building.md")).toBe(true);
      expect(result.hits.some((h) => h.path.includes("transcript"))).toBe(true);
      expect(result.hits.some((h) => h.path.includes(".nq"))).toBe(false);
      expect(result.summary).toContain("model=test-model");
      expect(result.summary).toContain("reasoning=low");
    } finally {
      await rmTempDir(root);
    }
  });

  test("guardToolCall blocks path escape and protected writes for fs tools", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const sb = await createSandbox({ campaignRoot: campaign });
      const escape = await guardToolCall(sb, "read", { path: "../outside.txt" });
      expect(escape.ok).toBe(false);
      const nq = await guardToolCall(sb, "write", {
        path: ".nq/play_state.json",
        content: "{}",
      });
      expect(nq.ok).toBe(false);
      const yaml = await guardToolCall(sb, "edit", {
        path: "campaign.yaml",
        content: "x",
      });
      expect(yaml.ok).toBe(false);
      const ok = await guardToolCall(sb, "read", { path: "player_sheet.md" });
      expect(ok.ok).toBe(true);
    } finally {
      await rmTempDir(root);
    }
  });

  test("extractToolPath reads hashline edit headers", () => {
    expect(
      extractHashlineEditPath(
        "[player_sheet.md#ABCD]\nSWAP 1.=1:\n+# hi\n",
      ),
    ).toBe("player_sheet.md");
    expect(
      extractToolPath("edit", {
        input: "[dossiers/pauk.md#ZZZZ]\nSWAP 1.=1:\n+# x\n",
      }),
    ).toBe("dossiers/pauk.md");
    expect(extractToolPath("edit", { input: "no header" })).toBe("");
    expect(extractToolPath("write", { path: "player_sheet.md" })).toBe(
      "player_sheet.md",
    );
  });
});
