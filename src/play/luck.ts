import type { PlayState } from "../campaign/types.ts";

/**
 * Luck Point ledger for one Game Master roll of a d`n`. Armed luck (with a
 * point to spend) returns the highest result and spends a point; a result of
 * `1`, or no more than five percent of the die, restores one. `next` is null
 * when the roll leaves the ledger as it was.
 */
export function rollWithLuck(
  state: PlayState,
  n: number,
  naturalRoll: () => number,
): { value: number; next: PlayState | null } {
  const spendsPoint = state.luck_armed && state.luck_points > 0;
  const value = spendsPoint ? n : naturalRoll();
  const restoresPoint = value === 1 || value * 20 <= n;
  const next: PlayState = {
    ...state,
    luck_points:
      state.luck_points - (spendsPoint ? 1 : 0) + (restoresPoint ? 1 : 0),
    luck_armed: !spendsPoint && state.luck_armed && state.luck_points > 0,
  };
  const changed =
    next.luck_points !== state.luck_points ||
    next.luck_armed !== state.luck_armed;
  return { value, next: changed ? next : null };
}

/** Arm or disarm luck; it cannot be armed at zero points. */
export function armLuck(state: PlayState, armed: boolean): PlayState {
  return { ...state, luck_armed: armed && state.luck_points > 0 };
}
