import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfigFile, mergeConfig } from "../../src/config.ts";
import {
  applyHomeSettings,
  homeSettingsFromConfig,
  parseHomeSettings,
  saveHomeSettings,
} from "../../src/home/settings.ts";
import { HomeSurface } from "../../src/home/surface.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster, says } from "../helpers/game_master.ts";

describe("Home settings", () => {
  test("persists every config setting without deleting unknown config", async () => {
    const root = await makeTempDir();
    try {
      const configPath = path.join(root, "config.toml");
      await writeFile(
        configPath,
        [
          "# keep this comment",
          'custom = "untouched"',
          "timeout = 180",
          "",
          "[play]",
          'reasoning = "medium"',
          'gm_voice = "old.md"',
          "transcript_tail = 20",
          "",
          "[compact]",
          "ceiling = 128000",
          "keep_tail_percent = 15",
          "keep_tail = 4000",
          "",
          "[plugin]",
          "enabled = true",
          "",
        ].join("\n"),
      );
      const settings = {
        ...homeSettingsFromConfig(mergeConfig({}, {})),
        model: "llama.cpp/slow-local",
        turnTimeoutSec: 900,
        reasoning: "high",
        hygieneN: 25,
        compactCeilingTokens: 256_000,
        compactSeedPercent: 35,
        playTranscriptTailRows: 42,
        searchFullModel: "openrouter/search-model",
        searchFullReasoning: "medium",
        gmVoicePath: "/tmp/gm-voice.md",
        gmPersonality: "Patient, severe, and attentive to old grudges.",
        localThinkingOpener:
          "First, map the relationships among everyone present.",
        debug: true,
        logPath: "/tmp/nq.log",
        servePort: 7788,
      };

      await saveHomeSettings(configPath, settings);

      const raw = await readFile(configPath, "utf8");
      expect(raw).toContain("# keep this comment");
      expect(raw).toContain('custom = "untouched"');
      expect(raw).toContain("[plugin]\nenabled = true");
      expect(raw).not.toContain('[play]\nreasoning = "medium"');
      expect(raw).not.toContain("keep_tail");
      expect(raw).toContain("seed_percent = 35");
      const loaded = mergeConfig(await loadConfigFile(configPath), {});
      expect(homeSettingsFromConfig(loaded)).toEqual(settings);
    } finally {
      await rmTempDir(root);
    }
  });

  test("validates ranges before mutating the active config", () => {
    const config = mergeConfig({}, {});
    const value = {
      ...homeSettingsFromConfig(config),
      turnTimeoutSec: 0,
    };
    expect(() => parseHomeSettings(value)).toThrow("turnTimeoutSec");
    expect(config.turnTimeoutMs).toBe(180_000);
    expect(() =>
      parseHomeSettings({ ...value, turnTimeoutSec: 600, compactSeedPercent: 0 }),
    ).toThrow("compactSeedPercent");
    expect(() =>
      parseHomeSettings({ ...value, turnTimeoutSec: 600, compactSeedPercent: 101 }),
    ).toThrow("compactSeedPercent");

    const parsed = parseHomeSettings({ ...value, turnTimeoutSec: 600 });
    applyHomeSettings(config, parsed);
    expect(config.turnTimeoutMs).toBe(600_000);
  });

  test("refreshes the model factory after request-affecting settings change", async () => {
    const root = await makeTempDir();
    try {
      const config = mergeConfig({ model: "llama.cpp/local-model" }, {});
      const before = await scriptedGameMaster({ fallback: says("old") });
      const madeModels: string[] = [];
      const after = await scriptedGameMaster({
        provider: "llama.cpp",
        fallback: says("The warden nods."),
      });
      const configPath = path.join(root, "config.toml");
      const surface = new HomeSurface({
        config,
        configPath,
        campaignsDir: path.join(root, "campaigns"),
        packsDir: path.join(root, "packs"),
        factory: before.factory,
        makeFactory: (model) => {
          madeModels.push(model);
          return after.factory;
        },
      });

      await surface.updateSettings({
        ...homeSettingsFromConfig(config),
        gmPersonality: "Patient and severe.",
        localThinkingOpener: "First, map the relationships.",
      });

      expect(madeModels).toEqual(["llama.cpp/local-model"]);
      expect(config.gmPersonality).toBe("Patient and severe.");
      expect(config.localThinkingOpener).toBe(
        "First, map the relationships.",
      );
      const saved = mergeConfig(await loadConfigFile(configPath), {});
      expect(saved.gmPersonality).toBe("Patient and severe.");

      // the next adventure plays on the rebuilt Game Master with the new voice
      const campaign = await birthCampaign(root);
      await surface.openPath(campaign);
      const result = await surface.play!.loop.turn("I bow.");
      expect(result.outcome).toBe("success");
      expect(result.prose).toBe("The warden nods.");
      expect(before.calls).toHaveLength(0);
      expect(after.calls[0]!.system).toContain("Patient and severe.");
      await surface.leave();
    } finally {
      await rmTempDir(root);
    }
  });
});
