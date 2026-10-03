import type { ScratchRecord } from "../campaign/types.ts";
import { displayRollReason } from "./dice.ts";

/** One completed Game Master roll, as the Roll Log lists it. */
export type RollLogEntry = {
  key: string;
  turn: number;
  n: number;
  value: number;
  /** The Game Master's stated purpose; absent when it gave none. */
  reason?: string;
};

/**
 * The Roll Log: every completed roll in the Campaign's Scratch, newest
 * first. A roll without a stated purpose keeps none; nothing is inferred.
 */
export function rollHistory(
  records: ReadonlyArray<Pick<ScratchRecord, "ts" | "turn" | "tools">>,
): RollLogEntry[] {
  const rolls: RollLogEntry[] = [];
  for (const record of records) {
    record.tools.forEach((tool, index) => {
      if (
        tool.name !== "roll" ||
        tool.n === undefined ||
        tool.value === undefined
      ) {
        return;
      }
      rolls.push({
        key: `${record.ts}:${index}`,
        turn: record.turn,
        n: tool.n,
        value: tool.value,
        ...(tool.reason ? { reason: displayRollReason(tool.reason) } : {}),
      });
    });
  }
  rolls.reverse();
  return rolls;
}
