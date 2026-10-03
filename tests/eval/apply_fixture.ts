import { appendFile, cp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { newCampaign, savePlayState } from "../../src/campaign/index.ts";
import {
  generateLongTranscript,
  serializeTranscript,
} from "./long_session.ts";

export const MEMORY_GYM_PACK_DIR = path.resolve(
  import.meta.dir,
  "packs/memory-gym",
);

export const BRINEWATCH_PACK_DIR = path.resolve(
  import.meta.dir,
  "../../packs/brinewatch",
);

export const DIRTY_MIDGAME_DIR = path.resolve(
  import.meta.dir,
  "fixtures/dirty-midgame",
);

export const DIRTY_LONG_DIR = path.resolve(
  import.meta.dir,
  "fixtures/dirty-long",
);

const OVERLAY_FILES = [
  "player_sheet.md",
  "world-building.md",
  "quest-log.md",
  "story-beats.md",
  "transcript.jsonl",
] as const;

/**
 * Birth a Campaign from the Memory Gym Seed Pack, then overlay the dirty
 * midgame fixture (rotten memory + planted transcript). Hygiene has never run.
 */
export async function birthDirtyMemoryGym(root: string): Promise<string> {
  const campaign = path.join(root, "camp");
  await newCampaign({
    path: campaign,
    packDir: MEMORY_GYM_PACK_DIR,
    name: "Memory Gym",
  });

  for (const rel of OVERLAY_FILES) {
    await cp(path.join(DIRTY_MIDGAME_DIR, rel), path.join(campaign, rel));
  }

  const fixtureDossiers = path.join(DIRTY_MIDGAME_DIR, "dossiers");
  const names = await readdir(fixtureDossiers);
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    await cp(
      path.join(fixtureDossiers, name),
      path.join(campaign, "dossiers", name),
    );
  }

  await savePlayState(campaign, {
    success_turn_count: 10,
    luck_points: 5,
    luck_armed: false,
  });
  return campaign;
}

const WORLD_ROT = `

## Tide Choir (copy)

The Tide Choir only sings on fog-neap nights. Locals treat it as weather, not religion.

## Tide Choir (again)

The Tide Choir only sings on fog-neap nights. Locals treat it as weather, not religion.

## Fluff to compress

Brinewatch is small. Brinewatch is very small. The dock is the town. The town is the dock. People mention the dock. People mention the tavern. People mention the well. The well is behind the nets. The nets are by the well. Fog comes. Fog goes. Gulls argue. Gulls still argue.
`;

/**
 * Birth a Campaign from the mid-size Brinewatch Seed Pack, overlay a rotten
 * midgame, and write a generated transcript ≥ 40k tokens.
 */
export async function birthLongBrinewatch(root: string): Promise<{
  campaign: string;
  transcriptTokens: number;
  playerTurns: number;
}> {
  const campaign = path.join(root, "camp");
  await newCampaign({
    path: campaign,
    packDir: BRINEWATCH_PACK_DIR,
    name: "Brinewatch Long Eval",
  });

  for (const rel of ["player_sheet.md", "quest-log.md", "story-beats.md"] as const) {
    await cp(path.join(DIRTY_LONG_DIR, rel), path.join(campaign, rel));
  }

  const fixtureDossiers = path.join(DIRTY_LONG_DIR, "dossiers");
  const names = await readdir(fixtureDossiers);
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    await cp(
      path.join(fixtureDossiers, name),
      path.join(campaign, "dossiers", name),
    );
  }

  await appendFile(path.join(campaign, "world-building.md"), WORLD_ROT);

  const generated = generateLongTranscript();
  await writeFile(
    path.join(campaign, "transcript.jsonl"),
    serializeTranscript(generated.rows),
  );
  await savePlayState(campaign, {
    success_turn_count: generated.playerTurns,
    luck_points: 5,
    luck_armed: false,
  });
  return {
    campaign,
    transcriptTokens: generated.tokens,
    playerTurns: generated.playerTurns,
  };
}
