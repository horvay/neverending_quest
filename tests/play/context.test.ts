import { describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GmVoiceError,
  PinOverflowError,
  PlayLoop,
  RUNTIME_CONTRACT,
} from "../../src/play/index.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster, type ModelCall } from "../helpers/game_master.ts";

/** A reply the Illustration looker would give: tags, then one sentence. */
const LOOKER_REPLY =
  "masterpiece, best quality, score_7, safe, 1boy, ranger, marsh, fog. A weary ranger wades through the fog.";

async function sessionJournals(campaign: string): Promise<string[]> {
  try {
    return await readdir(path.join(campaign, ".nq", "sessions"), {
      recursive: true,
    });
  } catch {
    return [];
  }
}

function isLookerCall(call: ModelCall): boolean {
  return !call.system.includes(RUNTIME_CONTRACT);
}

describe("Context Assembly", () => {
  test("the Game Master sees the global voice, Scenario seed, notes/tools contract, then pinned memory", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Voice\nSpeak sparsely.\n",
        dossiers: {
          "kira.md":
            "---\nname: Kira\naliases: [Kay]\nkind: person\nregard: 7\npersonality: Soft-spoken. Never rushes a name.\nappearance: dark hair, travel cloak\n---\nSECRET BODY\n",
        },
      });
      const gm = await scriptedGameMaster({
        fallback: (c) =>
          isLookerCall(c) ? c.say(LOOKER_REPLY) : c.say("The fog parts."),
      });
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        // image generation is the external boundary; the looker pass is real
        illustrator: { paintOne: async ({ outPath }) => {
          await Bun.write(outPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
        } },
      });
      await loop.open();
      expect((await loop.turn("I look around.")).outcome).toBe("success");

      const voice = (
        await readFile(
          new URL("../../src/play/gm_voice.md", import.meta.url),
          "utf8",
        )
      ).trim();
      const system = gm.calls[0]!.system;
      expect(
        system.startsWith(
          `${voice}\n\n# The Scenario\n\n# Voice\nSpeak sparsely.\n\n${RUNTIME_CONTRACT}\n\n## Pinned Campaign memory\n`,
        ),
      ).toBe(true);

      // the contract the Game Master plays by
      for (const line of [
        "`search_full` adds seed and transcript",
        "Campaign memory is read-only during a play Turn.",
        "Memory Hygiene alone writes Campaign memory",
        "During play use read, roll, search, and search_full.",
        "Apply **current truth** when checking the PC's inventory, powers, and standing facts.",
        "each involved character's relevant abilities and desires, the chosen approach, and the circumstances",
        "Praise sways an egoist more easily than someone unmoved by status.",
        "Before narrating the consequence, you MUST call `roll`.",
        "Match the consequence to the returned range and declared stakes.",
        "A roll decides only its declared stakes. Preserve personality, regard, and relationships across the result.",
        "Hostility follows from established motives or provoking conduct, not from failure itself.",
        "Examples, not fixed odds:",
        "**Joke:** `n=100`",
        "**Bluff a sentry:** `n=100`",
        "**Dagger attack:** `n=100`",
        "**New NPC:** `n=20`",
        "### Example Dossier",
        "Dossier bodies use only these exact optional H2 sections",
        "Chronology, encounters, recent actions, and event history belong only in Story Beats.",
        "Use `edit` for every existing dossier; `write` only creates a new dossier.",
        "## Inventory",
        "## Relationships",
        "## Abilities",
        "## Quirks",
        "## Establishment",
      ]) {
        expect(system).toContain(line);
      }
      expect(RUNTIME_CONTRACT).not.toMatch(/\bin-Turn\b|about to edit/iu);
      expect(system).not.toMatch(/Ultra|Use fragments|fewest clear words/u);
      for (const gone of ["## Acts", "## Common phrases", "Absolute player freedom"]) {
        expect(RUNTIME_CONTRACT).not.toContain(gone);
      }

      // pinned memory, in order, then the generated dossier catalog
      const pinned = system.slice(system.indexOf("## Pinned Campaign memory"));
      const order = [
        '<file path="player_sheet.md">',
        '<file path="world-building.md">',
        '<file path="quest-log.md">',
        '<file path="story-beats.md">',
        '<file path="twists.md">',
        '<file path="dossiers/kira.md:1-8">',
      ].map((marker) => pinned.indexOf(marker));
      expect(order.every((at) => at >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      const catalog = pinned.slice(order[5]!);
      expect(catalog).toContain("Kira");
      expect(catalog).toContain("Kay");
      expect(catalog).toContain("Soft-spoken. Never rushes a name.");
      expect(catalog).toContain("dark hair, travel cloak");
      expect(catalog).toContain("\nregard: 7\n");
      expect(catalog).toContain("[... 1 more line in file.]");
      expect(system).not.toContain("SECRET BODY");
      // the catalog is generated reference context, never a Campaign file
      expect(pinned).not.toContain('<file path="dossier-catalog.md">');

      // the Illustration looker sees only the sheet and the catalog
      await loop.illustrate();
      const looker = gm.calls.find(isLookerCall)!;
      // the looker brief is a hidden pass: a developer message, not a player line
      expect(looker.prompt).toBe("");
      expect(looker.instruction).toContain("Current scene:");
      expect(looker.instruction).toContain("The fog parts.");
      expect(looker.system).toContain('<file path="player_sheet.md">');
      expect(looker.system).toContain("dark hair, travel cloak");
      expect(looker.system).not.toContain("SECRET BODY");
      for (const absent of ["world-building.md", "quest-log.md", "story-beats.md", "twists.md"]) {
        expect(looker.system).not.toContain(`<file path="${absent}">`);
      }
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("gmVoicePath replaces the bundled Game Master voice", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, { seed: "# Voice\nPack.\n" });
      const custom = path.join(root, "custom-voice.md");
      await writeFile(custom, "CUSTOM TABLE VOICE\n", "utf8");
      const gm = await scriptedGameMaster();
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: {
          gmVoicePath: custom,
          gmPersonality: "Patient, severe, and attentive to old grudges.",
        },
      });
      await loop.open();
      await loop.turn("I wait.");
      const system = gm.calls[0]!.system;
      expect(system.startsWith("CUSTOM TABLE VOICE")).toBe(true);
      expect(system).toContain("# Voice\nPack.");
      // the personality says what it is for, so the model lets it color the telling
      const personality = system.slice(system.indexOf("# Game Master personality"));
      expect(personality).toMatch(
        /^# Game Master personality\n\nThe player chose who you are as the Game Master\. Let this color the whole telling[^\n]*\n\nPatient, severe, and attentive to old grudges\./,
      );
      expect(system.indexOf("CUSTOM TABLE VOICE")).toBeLessThan(
        system.indexOf("# Game Master personality"),
      );
      expect(system.indexOf("# Game Master personality")).toBeLessThan(
        system.indexOf("# The Scenario"),
      );
      expect(system).not.toContain("Play the world and its people");
      // the contract closes the prompt, before the pinned memory
      expect(system).toContain(`${RUNTIME_CONTRACT}\n\n## Pinned Campaign memory\n`);
      const runtimeStart = system.indexOf(RUNTIME_CONTRACT);
      for (const section of [
        "### Validity and freedom",
        "### Notes and file roles",
        "### NPC personalities",
      ]) {
        expect(system.indexOf(section)).toBeGreaterThan(runtimeStart);
        expect(system.split(section)).toHaveLength(2);
      }
      expect(system).not.toMatch(/Ultra|Use fragments|fewest clear words/u);
      await loop.close();
    } finally {
      await rmTempDir(root);
    }
  });

  test("a missing gmVoicePath fails open, not a silent default", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster();
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: { gmVoicePath: path.join(root, "nope.md") },
      });
      await expect(loop.open()).rejects.toBeInstanceOf(GmVoiceError);
      expect(gm.calls).toHaveLength(0);
    } finally {
      await rmTempDir(root);
    }
  });

  test("PlayLoop.open errors on pin overflow instead of truncating", async () => {
    const root = await makeTempDir();
    try {
      // 10k chars is ~2.5k tokens by the real estimator: far over a 100-token ceiling
      const campaign = await birthCampaign(root, {
        seed: "x".repeat(10_000),
      });
      const gm = await scriptedGameMaster();
      const loop = new PlayLoop({
        path: campaign,
        factory: gm.factory,
        config: {
          compactCeilingTokens: 100,
          completionReserveTokens: 20,
        },
      });
      const failure = await loop.open().catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(PinOverflowError);
      expect((failure as PinOverflowError).budget).toBe(80);
      expect((failure as PinOverflowError).estimated).toBeGreaterThan(2_500);
      // no Game Master session was ever started
      expect(gm.calls).toHaveLength(0);
      expect(await sessionJournals(campaign)).toEqual([]);
    } finally {
      await rmTempDir(root);
    }
  });
});
