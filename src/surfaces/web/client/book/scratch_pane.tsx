import { RevealProse } from "../reveal.tsx";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ScratchTool } from "../../../../campaign/types.ts";
import type { KernelState } from "../../../../play/kernel.ts";
import { formatScratchTools } from "../../../../play/scratch_format.ts";
import type { ScratchView } from "./types.ts";

export function scratchByTs(records: ScratchView[]): Map<string, ScratchView> {
  return new Map(records.map((row) => [row.ts, row]));
}

/**
 * How close to the bottom still counts as "at the bottom". Streaming text can
 * land between a scroll and its event, so an exact match would drop readers
 * who scrolled all the way down.
 */
const FOLLOW_SLACK_PX = 48;

export function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= FOLLOW_SLACK_PX;
}

export function ScratchPane(props: {
  thinking: string;
  tools: ScratchTool[];
  live?: boolean;
  cycleKey?: string;
  onEndReasoning?: () => Promise<boolean>;
  /** Replay this Turn, the Game Master thinking on from the end of `thinking`. */
  onContinueFrom?: (thinking: string) => unknown;
  busy?: boolean;
}) {
  const [requesting, setRequesting] = useState(false);
  const [requestedCycle, setRequestedCycle] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing === null) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    // the Game Master continues from the end, so that is where the caret waits
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
  }, [editing === null]);
  const bodyRef = useRef<HTMLDivElement>(null);
  // live scratch follows its newest line while the reader stays at the bottom
  const followRef = useRef(true);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!props.live || !el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [props.live, props.thinking, props.tools]);
  if (!props.thinking && props.tools.length === 0) return null;
  const tools = formatScratchTools(props.tools);
  const cycleKey = props.cycleKey ?? "";
  const requested = requestedCycle === cycleKey;
  const canEnd = Boolean(
    props.live && props.thinking && props.onEndReasoning,
  );
  const endReasoning = async () => {
    if (!props.onEndReasoning || requesting || requested) return;
    setRequesting(true);
    try {
      if (await props.onEndReasoning()) setRequestedCycle(cycleKey);
    } finally {
      setRequesting(false);
    }
  };
  const canEdit = Boolean(!props.live && props.thinking && props.onContinueFrom);
  if (editing !== null) {
    const continueFrom = () => {
      if (props.busy || !editing.trim()) return;
      void Promise.resolve(props.onContinueFrom?.(editing)).then((ok) => {
        if (ok !== false) setEditing(null);
      });
    };
    return (
      <div class="scratch-above is-editing">
        <label class="sr-only" for="edit-scratch">
          edit scratch
        </label>
        <textarea
          id="edit-scratch"
          class="scratch-edit"
          ref={editRef}
          value={editing}
          disabled={props.busy}
          onInput={(e) => setEditing((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(null);
            }
          }}
        />
        <p class="ink-actions">
          <button type="button" onClick={() => setEditing(null)}>
            Leave it
          </button>
          <button
            type="button"
            disabled={props.busy || !editing.trim()}
            onClick={continueFrom}
          >
            Continue
          </button>
        </p>
      </div>
    );
  }
  return (
    <div class={`scratch-above${props.live ? " is-live" : ""}`}>
      <div
        class="scratch-body"
        ref={bodyRef}
        onScroll={(e) => {
          followRef.current = atBottom(e.currentTarget);
        }}
      >
        {canEdit ? (
          <button
            type="button"
            class="scratch-edit-open"
            aria-label="Edit scratch"
            disabled={props.busy}
            onClick={() => setEditing(props.thinking)}
          >
            Edit
          </button>
        ) : null}
        {props.live ? (
          <div class="scratch-live-head">
            <div class="scratch-live-label">Scratch</div>
            {canEnd ? (
              <button
                type="button"
                class="reasoning-end"
                disabled={requesting || requested}
                onClick={() => void endReasoning()}
              >
                {requesting
                  ? "Ending reasoning"
                  : requested
                    ? "Answer requested"
                    : "Answer now"}
              </button>
            ) : null}
          </div>
        ) : null}
        {props.thinking ? (
          props.live ? (
            // live thinking fades in line by line, like the reply
            <RevealProse
              class="think"
              text={props.thinking}
              streaming
              onGrow={() => {
                const el = bodyRef.current;
                if (el && followRef.current) el.scrollTop = el.scrollHeight;
              }}
            />
          ) : (
            <div class="think">{props.thinking}</div>
          )
        ) : null}
        {tools ? <div class="tools">{tools}</div> : null}
      </div>
    </div>
  );
}

export function MaintenanceScratchPane(props: {
  scratch: NonNullable<KernelState["maintenanceScratch"]>;
  onEndReasoning?: () => Promise<boolean>;
}) {
  const { scratch } = props;
  const title =
    scratch.task === "compact"
      ? "Rebuild-compaction"
      : `Memory hygiene · ${scratch.mode ?? "light"}`;
  const state = scratch.live
    ? "Working"
    : scratch.ok === false
      ? "Failed"
      : "Complete";
  const hasScratch = Boolean(scratch.thinking || scratch.tools.length > 0);
  return (
    <details class="maintenance-scratch" open={scratch.live}>
      <summary>
        <span>{title}</span>
        <span class={`maintenance-state${scratch.ok === false ? " failed" : ""}`}>
          {state}
        </span>
      </summary>
      {hasScratch ? (
        <ScratchPane
          thinking={scratch.thinking}
          tools={scratch.tools}
          live={scratch.live}
          cycleKey={`${scratch.task}:${scratch.tools.length}`}
          onEndReasoning={props.onEndReasoning}
        />
      ) : (
        <p class="maintenance-empty">
          {scratch.live ? "Waiting for model activity…" : "No scratch was emitted."}
        </p>
      )}
    </details>
  );
}
