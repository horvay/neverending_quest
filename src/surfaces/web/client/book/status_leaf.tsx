import { estimateTokensDefault } from "../../../../play/tokens.ts";
import type { KernelState } from "../../../../play/kernel.ts";
import { leafMarginPhrase, type ContextUsage } from "../../../../play/leaf.ts";
import { statusColophon } from "../../../shared/status.ts";
import { clipProse, leavesLine, romanTurn } from "../../../shared/text.ts";
import type { RollLogEntry } from "../../../../play/roll_log.ts";
import type { HistoryEntry } from "./types.ts";

export function displayUsage(state: KernelState): ContextUsage | undefined {
  if (!state.context) return undefined;
  const extra = state.draft ? estimateTokensDefault(state.draft) : 0;
  return {
    used: state.context.used + extra,
    ceiling: state.context.ceiling,
  };
}

export function statusLine(state: KernelState): { text: string; kind: string } {
  if (state.lastError && state.phase === "idle") {
    return { text: state.lastError, kind: "err" };
  }
  if (state.phase === "turning") {
    return {
      text: `Turning… · Turn ${romanTurn(state.successTurnCount + 1)}`,
      kind: "busy",
    };
  }
  if (state.phase === "hygiene") {
    return {
      text: state.status || "Memory hygiene…",
      kind: "busy",
    };
  }
  if (state.phase === "compact") {
    return { text: "Rebuild-compaction…", kind: "busy" };
  }
  return { text: "", kind: "" };
}

export function StatusLeaf(props: {
  raw: string;
  locked: boolean;
  history: HistoryEntry[];
  context?: ContextUsage;
  rolls: RollLogEntry[];
  onHygiene?: (mode: "light" | "heavy" | "compact" | "fresh") => unknown;
  onLuck?: (armed: boolean) => unknown;
  onContinue: (turn: number) => void;
}) {
  const { name, turns, luckPoints, luckArmed, files } = statusColophon(
    props.raw,
  );
  const leaf = props.context
    ? leafMarginPhrase(props.context.used, props.context.ceiling)
    : undefined;
  return (
    <div class="colophon">
      {name ? <p class="colophon-title">{name}</p> : null}
      {turns !== undefined ? (
        <p class="colophon-turns">Turn {romanTurn(turns)} so far.</p>
      ) : null}
      {leaf ? <p class="colophon-leaf">{leaf.line}</p> : null}
      {files.length > 0 ? (
        <p class="colophon-files">{leavesLine(files)}</p>
      ) : null}
      <section class={`luck-points${luckArmed ? " is-armed" : ""}`}>
        <div class="luck-copy">
          <h2>Luck Points</h2>
          <p>
            {luckPoints > 0
              ? luckArmed
                ? "The next die will land on its highest face."
                : "Arm one point to max the next roll."
              : "No luck remains in this Campaign."}
          </p>
        </div>
        <button
          type="button"
          class="luck-switch"
          role="switch"
          aria-checked={luckArmed}
          aria-label="Use a Luck Point on the next roll"
          disabled={props.locked || luckPoints === 0}
          onClick={() => props.onLuck?.(!luckArmed)}
        >
          <span class="luck-count" aria-hidden="true">
            {Array.from({ length: 5 }, (_, index) => (
              <i key={index} class={index < luckPoints ? "is-full" : ""} />
            ))}
          </span>
          <span>{luckPoints} left</span>
        </button>
      </section>
      <section class="hygiene" aria-labelledby="hygiene-heading">
        <h2 id="hygiene-heading">Reconcile the book</h2>
        <p class="hygiene-lead">
          A reconciliation pass. The Game Master is not answering you — it
          rewrites the Campaign files so standing facts, story beats, and the
          quest log match what has been played.
        </p>
        <ul class="hygiene-actions">
          {(
            [
              [
                "light",
                "Catch up",
                "Write new story beats and refresh the open quest log.",
              ],
              [
                "heavy",
                "Tidy",
                "Compress and tidy the same files. Organize, keep the facts.",
              ],
              [
                "compact",
                "Compact",
                "Tidy, then restart the Game Master from disk. The story stays; only a recent tail is kept in mind.",
              ],
              [
                "fresh",
                "Fresh",
                "Tidy, then restart the Game Master with no prior dialogue in mind. The story stays in the book.",
              ],
            ] as const
          ).map(([mode, label, hint]) => (
            <li key={mode}>
              <button
                type="button"
                disabled={props.locked}
                onClick={() => props.onHygiene?.(mode)}
              >
                {label}
              </button>
              <span>{hint}</span>
            </li>
          ))}
        </ul>
      </section>
      <section class="roll-history" aria-labelledby="roll-history-heading">
        <h2 id="roll-history-heading">Rolls</h2>
        {props.rolls.length > 0 ? (
          <ol>
            {props.rolls.map((roll) => (
              <li key={roll.key}>
                <span class="roll-turn">Turn {romanTurn(roll.turn)}</span>
                <span class="roll-result">
                  {roll.value} / d{roll.n}
                </span>
                <span class="roll-reason">
                  {roll.reason ?? "Purpose not recorded."}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p class="roll-empty">No rolls have been made.</p>
        )}
      </section>
      {props.history.length > 0 ? (
        <div class="history-list">
          <h2>Earlier turns</h2>
          <ol>
            {props.history.map((entry) => (
              <li key={entry.turn}>
                <button
                  type="button"
                  class={entry.turn <= 0 ? "is-opening" : ""}
                  disabled={props.locked}
                  onClick={() => props.onContinue(entry.turn)}
                >
                  {entry.turn > 0 ? (
                    <span class="history-turn">{romanTurn(entry.turn)}</span>
                  ) : null}
                  <span class="history-prose">
                    {entry.turn <= 0 ? (
                      <span class="history-open">Opening</span>
                    ) : null}
                    {clipProse(entry.prose)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
