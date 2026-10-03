import { useEffect, useState } from "preact/hooks";
import type { ScratchTool } from "../../../../campaign/types.ts";
import { ScratchPane } from "./scratch_pane.tsx";

export function IllustrationFrame(props: {
  src: string;
  onOpen: () => void;
  onLoad?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [props.src]);
  if (failed) return null;
  return (
    <button
      type="button"
      class="illustration-open"
      aria-label="Look at this sitting"
      onClick={props.onOpen}
    >
      <img
        class="illustration"
        src={props.src}
        alt=""
        onLoad={props.onLoad}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

export function Easel(props: {
  prompt?: string;
  src?: string;
  busy?: boolean;
  scratch?: { thinking: string; tools: ScratchTool[] };
  candidates?: Array<string | undefined>;
  onLeave?: () => void;
  onRegenerate?: (prompt: string) => void;
  onPick?: (slot: number) => void;
}) {
  const looking = Boolean(props.src);
  const variants = props.candidates ?? [];
  const showingGrid = !looking && variants.some(Boolean);
  const readyCount = variants.filter(Boolean).length;
  const scratch = props.scratch;
  const hasScratch = Boolean(
    scratch && (scratch.thinking || scratch.tools.length > 0),
  );
  const [draft, setDraft] = useState(props.prompt ?? "");
  useEffect(() => {
    if (props.prompt !== undefined) setDraft(props.prompt);
  }, [props.prompt]);
  const live = looking
    ? props.prompt
      ? `The sitting. ${props.prompt}`
      : "The sitting."
    : showingGrid
      ? "Pick a sitting."
      : "The brush is mixing a sitting.";
  const canRegen =
    looking &&
    Boolean(props.onRegenerate) &&
    draft.trim().length > 0 &&
    !props.busy;
  return (
    <div
      class={`easel${looking ? " is-look" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-busy={looking && !props.busy ? undefined : true}
      aria-live={looking ? undefined : "polite"}
      aria-label={live}
    >
      <div class="easel-veil" onClick={props.onLeave} />
      <div class="easel-studio">
        <div class="easel-stage">
          <img class="easel-body" src="/ink/studio-easel.png" alt="" />
          <div
            class={`easel-canvas${showingGrid ? " is-grid" : ""}`}
            aria-hidden={showingGrid ? undefined : true}
          >
            {looking && props.src ? (
              <img class="easel-picture" src={props.src} alt="" />
            ) : showingGrid ? (
              [0, 1, 2, 3].map((slot) => {
                const src = variants[slot];
                if (src) {
                  return (
                    <button
                      key={slot}
                      type="button"
                      class="easel-cell"
                      aria-label="Use this sitting"
                      onClick={() => props.onPick?.(slot)}
                    >
                      <img src={src} alt="" />
                    </button>
                  );
                }
                return (
                  <div key={slot} class="easel-cell is-wait">
                    <div class="easel-wash" />
                  </div>
                );
              })
            ) : (
              <div class="easel-wash" />
            )}
          </div>
          <aside class="easel-scrap">
            <p class="easel-kicker">
              {looking ? "The sitting" : "Scratch"}
            </p>
            {looking ? (
              <textarea
                class="easel-prompt-edit"
                aria-label="The sitting"
                value={draft}
                disabled={props.busy}
                rows={4}
                spellcheck={false}
                onInput={(e) =>
                  setDraft((e.target as HTMLTextAreaElement).value)
                }
              />
            ) : hasScratch ? (
              <ScratchPane
                thinking={scratch!.thinking}
                tools={scratch!.tools}
                live
              />
            ) : (
              <p class="easel-prompt is-mix">
                {showingGrid
                  ? readyCount === 4
                    ? "Pick one sitting."
                    : `Painting ${readyCount + 1} of 4. Any finished sitting can be picked now.`
                  : "The brush is mixing pigments."}
              </p>
            )}
            {hasScratch && !looking && showingGrid ? (
              <p class="easel-prompt is-mix">
                {readyCount === 4
                  ? "Pick one sitting."
                  : `Painting ${readyCount + 1} of 4. Any finished sitting can be picked now.`}
              </p>
            ) : null}
            <p class="easel-actions">
              {canRegen ? (
                <button
                  type="button"
                  onClick={() => props.onRegenerate?.(draft.trim())}
                >
                  Regenerate
                </button>
              ) : null}
              {canRegen && props.onLeave ? (
                <span class="easel-sep" aria-hidden="true">
                  ·
                </span>
              ) : null}
              {props.onLeave ? (
                <button type="button" onClick={props.onLeave}>
                  Leave it
                </button>
              ) : null}
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}
