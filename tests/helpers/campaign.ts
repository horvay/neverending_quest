import { mkdtempSync, rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newCampaign } from "../../src/campaign/index.ts";
import { writePack } from "./fs.ts";

const FIXED_NOW = new Date("2026-08-07T12:00:00.000Z");

/**
 * Birthing a Campaign (files, git init, first commit) costs ~40ms and the
 * result is fully determined by its inputs (fixed id and clock), so each
 * distinct Campaign is born once per test process and copied after that.
 */
let templateDir: string | undefined;
const templates = new Map<string, Promise<string>>();

function templatesRoot(): string {
  if (!templateDir) {
    templateDir = mkdtempSync(path.join(os.tmpdir(), "nq-test-campaigns-"));
    const dir = templateDir;
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return templateDir;
}

export async function birthCampaign(
  root: string,
  opts?: {
    name?: string;
    id?: string;
    seed?: string;
    sheet?: string;
    world?: string;
    /** Keys may be slug (`mira`) or filename (`mira.md`). */
    dossiers?: Record<string, string>;
  },
): Promise<string> {
  const name = opts?.name ?? "camp";
  const id = opts?.id ?? "11111111-2222-4333-8444-555555555555";
  const pack = path.join(root, `pack-${opts?.name ?? "default"}`);
  const campaign = path.join(root, name);
  const files: Record<string, string> = {
    "seed.md": opts?.seed ?? "# Seed\nYou are the Game Master of a haunted marsh.\n",
    "player_sheet.md":
      opts?.sheet ??
      "## Description\nA weary ranger.\n\n## Inventory\n- bow\n\n## Powers\n\n## Notes\n",
  };
  if (opts?.world) files["world-building.md"] = opts.world;
  if (opts?.dossiers) {
    for (const [key, body] of Object.entries(opts.dossiers)) {
      const file = key.endsWith(".md") ? key : `${key}.md`;
      files[`dossiers/${file}`] = body;
    }
  }
  await writePack(pack, files);

  const key = JSON.stringify({ name, id, files });
  let template = templates.get(key);
  if (!template) {
    const born = path.join(templatesRoot(), String(templates.size), name);
    template = newCampaign({
      path: born,
      packDir: pack,
      now: () => FIXED_NOW,
      id: () => id,
    }).then(() => born);
    templates.set(key, template);
    template.catch(() => templates.delete(key));
  }
  await cp(await template, campaign, {
    recursive: true,
    preserveTimestamps: true,
  });
  return campaign;
}
