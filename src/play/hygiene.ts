import type { PlayState } from "../campaign/types.ts";

export function buildHygieneInstruction(opts: {
  mode: "light" | "heavy";
  playState: PlayState;
  transcriptFromLine: number;
  transcriptLineCount: number;
}): string {
  const { mode, playState, transcriptFromLine, transcriptLineCount } = opts;
  const rangeEnd = Math.max(transcriptLineCount - 1, transcriptFromLine);
  const heavyExtra =
    mode === "heavy"
      ? `

HEAVY MODE (mandatory before rebuild-compaction) is done when:
- Memory files are compressed, deduped, and organized, with the same standing facts retained.
- story-beats.md is merged: beats telling one event are one line, and every name, number, quantity, negation, cause, and time qualifier from the merged lines survives in the line that replaces them.
- Player Sheet H2s are present; powers live under ## Powers.
- Dossier merges are keeper + thin stub_of; every slug still exists (live or archived).
- Leaves that have left the story are archived.
- twists.md is rethought against the current board: stale twists are cut and replaced, so the surviving ones still hang off people and quests that are live.

Merge story beats that tell one event into a single line carrying every fact. A merge is sound when the surviving line answers everything the originals answered: who acted, what happened, how many, whether it failed, and when.

Bad (one event spread over three beats):
- Fredicus asked Varn about factions under the city.
- Varn named the Under Toe, a halfling kin gang in the crawlspaces.
- Varn did not know who leads them.

Good (one beat, every fact kept):
- Fredicus asked Varn about factions under the city; Varn named the Under Toe, a halfling kin gang in the crawlspaces, and did not know who leads them.

Merge beats that restate each other. Keep a beat whole when merging would drop a name, a number, a negation, or a cause: two beats that share a subject but carry different facts stay two beats.`
      : "";

  return `[Memory Hygiene — ${mode} — hidden system pass]
You write *notes*. Final assistant text is discarded.

Memory records the story world only. Never write about the Game Master, the rules, the transcript, or what was skipped or is still undecided.

Put event history only in story-beats.md, appending one compact factual beat per line. Dossiers contain current, durable facts about their subject, not scene summaries, recent actions, or one-off reactions. Record a lasting trait or relationship only when supported by an explicit commitment, a lasting change, or recurring evidence; never generalize one scene into a permanent characteristic. Use compact factual fragments for memory edits, preserving names, numbers, negation, causality, and scope or time qualifiers.
An event can change a standing fact: log a lost sword in Story Beats and update the subject's Inventory, without retelling the loss in the dossier. A refusal while wounded belongs in Story Beats, not a permanent refusal in Quirks.
Across every memory file, record durable relationship facts rather than memorable phrasing. Keep exact quotes only when the wording matters to a promise, clue, threat, or callback.
A Relationships bullet says who this person is to someone and how they feel about them, in one line. An objection to a plan, a tactical refusal, a route taken, or an opinion voiced in one scene is a Story Beat, never a Relationships bullet: "will not wear a cutter's wrap: size, brand, gangs know their own" belongs in story-beats.md, while "escape ally of Fredicus; attracted to him" belongs here. When a Relationships section has grown into a scene log, cut it back to standing facts and move the rest to Story Beats. Keep Relationships to at most eight bullets per person. Phrase each bullet as what the person wants, likes, or does, not as a refusal: write "prefers the hill routes to the gates" rather than "will not use a gate". A refusal becomes a Relationships fact only when it is a hard limit the person would fight over.

twists.md is your private plan for where the story could go, not a record of where it has been. Keep 3 to 6 unspent twists, each one line: a concealed fact, a hidden motive, a reversal, or a cost the player has not seen coming. Every twist must grow out of something already on the board — a named person, an open quest, a thing in the beats — and must name what would reveal it. A twist must fit the seed and the person's Dossier: never give someone a secret that contradicts who they are.

Bad (a story beat wearing a twist's coat, and a twist out of nowhere):
- Varn told Fredicus about the Under Toe.
- A dragon arrives and burns the city.

Good (grounded, concealed, with a trigger):
- Varn already works for the Under Toe; he steered Fredicus to the crawlspaces on their orders. Surfaces if Fredicus follows him after a handoff.
- The templar seal on Fredicus's writ is a forgery Hadran sold him; any templar who reads it closely calls it out.

Delete a twist once it has landed — what happened then belongs in story-beats.md — and delete one the story has made impossible. Never reveal a twist in prose because it is written here; it fires when play earns it.

Done when:
1. Standing facts from transcript lines ${transcriptFromLine}..${rangeEnd} (0-based in transcript.jsonl) are in player_sheet.md, world-building.md, and dossier *leaves*.
   - A *leaf* holds subject facts only. Chronicle of what happened is in story-beats.md.
   - Every dossier keeps its YAML fence (\`name\`, \`aliases\`, \`kind\`; \`regard\` from 1 to 10 on people; \`personality\` on people; \`appearance\` how they look; \`stub_of\` on stubs). Preserve \`regard\` unless new standing facts support a lasting change.
   - Dossier bodies use only the allowed optional H2 sections: Inventory (people only), Relationships, Abilities, Quirks, and Establishment (places only). New leaves start with every applicable heading, even when empty.
   - Move chronology, encounters, recent actions, and event history to story-beats.md; remove substitute dossier sections and unheaded body prose. Leave older story beats as they stand; heavy mode merges them.
   - When maintaining an affected dossier, remove unsupported generalizations and stale catchphrase-only scraps such as "no leash; not a choir." Leave unrelated dossiers alone; preserve the scene event in existing or newly appended Story Beats.
   - Use edit for existing dossiers; write only when creating a new dossier. Make surgical changes and preserve unrelated facts.
   - Treat existing memory as current truth only when supported. Preserve canon, user-authored personality, regard, relationships, and other standing facts; do not sanitize or overwrite standing facts just because the recent transcript omits them. Correct unsupported generalizations when their source shows only a momentary reaction or scoped choice.
   - Player Sheet ## Notes hold only what the next Turn must not forget (inventory, location, stamps, obligations).
2. story-beats.md has new chronicle lines appended for what happened and what the player did.
3. quest-log.md holds only open leads, each one a thing the player could pursue next; resolved or dead entries are gone. It is not a status summary.
   Bad: "Kel Sorn is alive but injured in the holding run." Good: "Escape the Arena undercroft before the alarm spreads; the intake stairs lead up to the street."
4. twists.md holds 3 to 6 unspent, grounded twists; landed and impossible ones are deleted.
5. Keep only people and places still in the current story under \`dossiers/\`. Archive the rest with the \`archive\` tool (\`archive=true\`). Dead, left-behind, and one-shot leaves go to \`dossiers/archive/\`. They stay searchable. Keep a leaf live when the PC will meet them again soon.
6. You have read the last 15–20 story beats for continuity before appending.

Prior successful hygiene cursor: line ${playState.last_hygiene_transcript_line ?? 0}.
success_turn_count: ${playState.success_turn_count}.

Tools: read, edit, write, search, search_full, archive. Write only player_sheet.md, world-building.md, dossiers, story-beats.md, quest-log.md, and twists.md.
${heavyExtra}

When done, reply with a one-line internal summary (discarded).`;
}

/**
 * Light hygiene is due N successful Turns after the last hygiene pass of any
 * kind. Every pass — automatic, manual light/heavy, and rebuild-compaction —
 * stamps `last_hygiene_success_turn`, so any of them restarts the count instead
 * of leaving the next automatic pass pinned to an absolute multiple of N.
 */
export function hygieneDue(
  playState: PlayState,
  hygieneN: number,
): "light" | false {
  if (hygieneN <= 0) return false;
  const count = playState.success_turn_count;
  if (count <= 0) return false;
  const last = Math.min(playState.last_hygiene_success_turn ?? 0, count);
  if (count - last >= hygieneN) return "light";
  return false;
}

/**
 * Play state after a Memory Hygiene pass. Every pass restarts the light
 * clock; only a pass that succeeded moves the transcript cursor, so a failed
 * or stopped pass leaves its Turns for the next one.
 */
export function afterHygienePass(
  playState: PlayState,
  pass: {
    mode: "light" | "heavy";
    ok: boolean;
    at: string;
    error?: string;
    transcriptLineCount: number;
  },
): PlayState {
  if (pass.ok) {
    return {
      ...playState,
      last_hygiene_success_turn: playState.success_turn_count,
      last_hygiene_transcript_line: Math.max(pass.transcriptLineCount - 1, 0),
      last_hygiene_at: pass.at,
      last_hygiene_status: "ok",
      last_hygiene_error: undefined,
      last_hygiene_mode: pass.mode,
    };
  }
  return {
    ...playState,
    last_hygiene_success_turn: playState.success_turn_count,
    last_hygiene_at: pass.at,
    last_hygiene_status: "fail",
    last_hygiene_error: pass.error ?? "hygiene failed",
    last_hygiene_mode: pass.mode,
    // do NOT advance last_hygiene_transcript_line
  };
}
