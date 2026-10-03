import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CampaignError } from "./errors.ts";
import { isEnoent } from "./fs_util.ts";

import { PLAY_STATE_JSON } from "./paths.ts";
import type { PlayState } from "./types.ts";

export const INITIAL_LUCK_POINTS = 5;

export function defaultPlayState(): PlayState {
  return {
    success_turn_count: 0,
    luck_points: INITIAL_LUCK_POINTS,
    luck_armed: false,
  };
}

export async function loadPlayState(campaignPath: string): Promise<PlayState> {
  const abs = path.join(campaignPath, PLAY_STATE_JSON);
  try {
    const raw = await readFile(abs, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new CampaignError("play_state_invalid", `Invalid play_state at ${abs}`);
    }
    const obj = parsed as Record<string, unknown>;
    const count = obj.success_turn_count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new CampaignError(
        "play_state_invalid",
        `play_state.success_turn_count missing or invalid at ${abs}`,
      );
    }
    const luckPoints = obj.luck_points ?? INITIAL_LUCK_POINTS;
    if (
      typeof luckPoints !== "number" ||
      !Number.isSafeInteger(luckPoints) ||
      luckPoints < 0
    ) {
      throw new CampaignError(
        "play_state_invalid",
        `play_state.luck_points invalid at ${abs}`,
      );
    }
    const luckArmed = obj.luck_armed ?? false;
    if (typeof luckArmed !== "boolean") {
      throw new CampaignError(
        "play_state_invalid",
        `play_state.luck_armed invalid at ${abs}`,
      );
    }
    const state: PlayState = {
      success_turn_count: count,
      luck_points: luckPoints,
      luck_armed: luckArmed && luckPoints > 0,
    };
    if (typeof obj.last_hygiene_success_turn === "number") {
      state.last_hygiene_success_turn = obj.last_hygiene_success_turn;
    }
    if (typeof obj.last_hygiene_transcript_line === "number") {
      state.last_hygiene_transcript_line = obj.last_hygiene_transcript_line;
    }
    if (typeof obj.last_hygiene_at === "string") {
      state.last_hygiene_at = obj.last_hygiene_at;
    }
    if (obj.last_hygiene_status === "ok" || obj.last_hygiene_status === "fail") {
      state.last_hygiene_status = obj.last_hygiene_status;
    }
    if (typeof obj.last_hygiene_error === "string") {
      state.last_hygiene_error = obj.last_hygiene_error;
    }
    if (obj.last_hygiene_mode === "light" || obj.last_hygiene_mode === "heavy") {
      state.last_hygiene_mode = obj.last_hygiene_mode;
    }
    return state;
  } catch (err) {
    if (err instanceof CampaignError) throw err;
    if (isEnoent(err)) return defaultPlayState();
    throw err;
  }
}

export async function savePlayState(
  campaignPath: string,
  state: PlayState,
): Promise<void> {
  const abs = path.join(campaignPath, PLAY_STATE_JSON);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(state, null, 2)}\n`);
}

