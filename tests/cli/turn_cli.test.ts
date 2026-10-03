import { describe, expect, test } from "bun:test";
import path from "node:path";
import { birthCampaign } from "../helpers/campaign.ts";
import { runCli } from "../helpers/cli.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import { scriptedGameMaster } from "../helpers/game_master.ts";
import type { AgentSessionFactory } from "../../src/play/types.ts";
import { readTranscript } from "../../src/campaign/index.ts";

function runNq(
  args: string[],
  env: Record<string, string> = {},
  factory?: AgentSessionFactory,
) {
  return runCli(args, { env, ...(factory ? { factory } : {}) });
}

describe("nq turn CLI", () => {
  test("SUCCESS prints GM prose on stdout only", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({
        steps: [
          (c) => {
            c.think("The marsh is quiet.");
            c.say("Wind answers.");
          },
        ],
      });
      const { stdout, stderr, code } = await runNq(
        ["turn", campaign, "-p", "I listen"],
        {},
        gm.factory,
      );
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("Wind answers.");
      expect(stderr).not.toContain("Wind answers.");
      expect(stdout).not.toContain("The marsh is quiet.");
      expect(gm.calls).toHaveLength(1);
      expect(gm.calls[0]!.prompt).toContain("I listen");
      const rows = await readTranscript(campaign);
      expect(rows.map((r) => [r.role, r.text])).toEqual([
        ["player", "I listen"],
        ["gm", "Wind answers."],
      ]);
    } finally {
      await rmTempDir(root);
    }
  });

  test("empty -p sends (continue) to the Game Master and still succeeds", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const gm = await scriptedGameMaster({ steps: [(c) => c.say("Time drifts.")] });
      const { code, stdout } = await runNq(
        ["turn", campaign, "-p", "  "],
        {},
        gm.factory,
      );
      expect(code).toBe(0);
      expect(stdout).toContain("Time drifts.");
      expect(gm.calls[0]!.prompt).toContain("(continue)");
    } finally {
      await rmTempDir(root);
    }
  });

  test("live turn rejects an absent NQ model instead of using OMP's default", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const config = path.join(root, "nq.toml");
      // with the fake off, the CLI talks to the local inference host; keep it
      // away from the real one so this test can never unload a live model
      const { code, stderr } = await runNq(
        ["turn", campaign, "--config", config, "-p", "I listen"],
        {
          NQ_FAKE_AGENT: "",
          NQ_USE_FAKE: "",
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CONFIG_HOME: path.join(root, "config"),
        },
      );
      expect(code).toBe(1);
      expect(stderr).toContain("No Game Master model is configured");
    } finally {
      await rmTempDir(root);
    }
  });

  test("nq login reaches the embedded OMP provider picker", async () => {
    const { code, stderr } = await runNq(["login"]);
    expect(code).toBe(1);
    expect(stderr).toContain("`nq login` requires an interactive terminal.");
  });

  test("nq login refuses the one-shot --model flag", async () => {
    const { code, stderr } = await runNq([
      "login",
      "--model",
      "xai-oauth/grok-4.5",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("`--model` applies only to one `nq play` or `nq turn`");
  });

  test(
    "nq new + show status smoke",
    async () => {
    const root = await makeTempDir();
    try {
      const pack = path.join(root, "pack");
      await Bun.write(path.join(pack, "seed.md"), "# S\n");
      await Bun.write(
        path.join(pack, "player_sheet.md"),
        "## Description\n\n## Inventory\n\n## Powers\n\n## Notes\n",
      );
      const camp = path.join(root, "cli-camp");
      const created = await runNq([
        "new",
        camp,
        "--pack",
        pack,
        "--name",
        "CLI Camp",
      ]);
      expect(created.code).toBe(0);
      const shown = await runNq(["show", camp, "status"]);
      expect(shown.code).toBe(0);
      expect(shown.stdout).toContain("name: CLI Camp");
      expect(shown.stdout).toContain("success_turn_count: 0");
    } finally {
      await rmTempDir(root);
    }
    },
  );
});
