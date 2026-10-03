import { Fragment } from "preact";
import { RevealProse } from "./reveal.tsx";
import { useEffect, useRef, useState } from "preact/hooks";
import { gmTurnsByIndex } from "../../../play/kernel.ts";
import { leafMarginPhrase, leafSpentRatio } from "../../../play/leaf.ts";
import { liveScratchOpen } from "../../../play/scratch_format.ts";
import { QuillIcon } from "./ornament.tsx";
import { markBookOpened } from "./visits.ts";
import { WhoChip } from "./book/chips.tsx";
import { InspectPage } from "./book/inspect_page.tsx";
import { Easel, IllustrationFrame } from "./book/easel.tsx";
import { LocalLogDrawer } from "./book/local_log.tsx";
import {
  MaintenanceScratchPane,
  ScratchPane,
  atBottom,
  scratchByTs,
} from "./book/scratch_pane.tsx";
import { displayUsage, statusLine } from "./book/status_leaf.tsx";
import { romanTurn } from "../../shared/text.ts";
import { rowKey } from "./book/text.ts";
import type { BookAppProps } from "./book/types.ts";

export type {
  BookAppProps,
  HistoryEntry,
  IllustratingView,
  InspectView,
  PlaySettingsView,
  ScratchView,
} from "./book/types.ts";

export function BookApp(props: BookAppProps) {
  const {
    state,
    inspect,
    campaignName = "Campaign",
    onSubmit,
    onInterrupt,
    onInspect,
    onSaveInspect,
    onCreateDossier,
    onArchiveDossier,
    onHygiene,
    onLuck,
    onEditTranscript,
    onDeleteTranscript,
    onRetryTranscript,
    onContinue,
    onLeave,
    canEndReasoning = false,
    canEditScratch = false,
    onEndReasoning,
    onReadLocalLog,
    authoring = false,
    scratch = [],
    history = [],
    illustrationReady = false,
    onIllustrate,
    illustrateTick = 0,
    illustrating = null,
    sittingPrompts = {},
    onDismissEasel,
    onPickIllustration,
    notice = "",
    playSettings,
    fixedSettings,
    onSavePlaySettings,
  } = props;
  const [composeText, setComposeText] = useState("");
  const [railOpen, setRailOpen] = useState(false);
  const [leafTip, setLeafTip] = useState(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [openScratch, setOpenScratch] = useState<string | null>(null);
  const [localLogOpen, setLocalLogOpen] = useState(false);
  const [editing, setEditing] = useState<{ ts: string; text: string } | null>(
    null,
  );
  const [confirmTurn, setConfirmTurn] = useState<number | null>(null);
  const [looking, setLooking] = useState<{
    src: string;
    prompt?: string;
  } | null>(null);
  const easelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    markBookOpened();
  }, []);

  const playRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const lastAutoScrollTopRef = useRef<number | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const busy = state.busy || authoring;
  const confirming = confirmTurn !== null;
  const locked = busy || confirming;
  const latestStory = state.story.length - 1;
  const lastStory = state.story[latestStory];
  // the latest message has no reply: its Turn failed or was stopped
  const unansweredTs =
    state.phase === "idle" &&
    lastStory?.role === "player" &&
    lastStory.ts &&
    onRetryTranscript
      ? lastStory.ts
      : undefined;
  const status =
    notice.trim() && state.phase === "idle"
      ? { text: notice.trim(), kind: "err" }
      : unansweredTs
        ? // the note under the message says why, beside its own Try again
          { text: "", kind: "" }
        : statusLine(state);
  const canSend = !locked;
  const maintenanceAfter = state.maintenanceScratch
    ? Math.min(state.maintenanceScratch.afterStoryCount, state.story.length)
    : -1;
  const extending =
    state.phase === "turning" && lastStory?.role === "gm";
  const draftLatest =
    state.phase === "turning" && Boolean(state.draft) && !extending;
  const liveOpen = liveScratchOpen(state.liveScratch);

  // A reply fades in line by line while it streams. When the Turn ends, the
  // finished row picks the reveal up where the live one left it, so the
  // last lines do not pop in at once.
  const revealLinesRef = useRef(0);
  const revealingRef = useRef<{ storyLen: number } | null>(null);
  const handoffRef = useRef<{ key: string; lines: number } | null>(null);
  /** Rows that took over from a live reply: already on the page, so no entrance. */
  const settledRef = useRef(new Set<string>());
  if (draftLatest || extending) {
    revealingRef.current ??= { storyLen: state.story.length };
  } else if (revealingRef.current) {
    const lastRow = state.story[state.story.length - 1];
    const grew = state.story.length > revealingRef.current.storyLen;
    if (lastRow?.role === "gm" && (grew || state.story.length === revealingRef.current.storyLen)) {
      handoffRef.current = {
        key: lastRow.ts ?? String(state.story.length - 1),
        lines: revealLinesRef.current,
      };
      settledRef.current.add(handoffRef.current.key);
    }
    revealingRef.current = null;
    revealLinesRef.current = 0;
  }
  const liveOnDraft = liveOpen && !extending;
  const usage = displayUsage(state);
  const leaf = usage
    ? leafMarginPhrase(usage.used, usage.ceiling)
    : undefined;
  const spentPct = usage
    ? Math.round(leafSpentRatio(usage.used, usage.ceiling) * 100)
    : 0;
  const remainPct = 100 - spentPct;
  // the desk (wide) and the page head (narrow) each draw one brush and well
  const brush = (cls: string) =>
    illustrationReady && onIllustrate ? (
      <button
        type="button"
        class={cls}
        disabled={locked}
        aria-label="Illustrate this line"
        onClick={() => {
          if (locked) return;
          void onIllustrate();
        }}
      >
        <img class="brush-body" src="/ink/brush.png" alt="" />
      </button>
    ) : null;
  const inkwell = (tipId: string) => (
    <div
      class={`inkwell${remainPct <= 8 ? " is-dry" : remainPct <= 25 ? " is-low" : ""}`}
      style={{ "--ink-left": `${remainPct}%` }}
      role="meter"
      tabindex={0}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={remainPct}
      aria-label={leaf?.phrase ?? "the well is full"}
      aria-describedby={tipId}
      onMouseEnter={() => setLeafTip(true)}
      onMouseLeave={() => setLeafTip(false)}
      onFocus={() => setLeafTip(true)}
      onBlur={() => setLeafTip(false)}
    >
      <div class="inkwell-bowl" aria-hidden="true">
        <div class="inkwell-liquid" />
      </div>
      <img class="inkwell-body" src="/ink/well.png" alt="" />
    </div>
  );
  const leafTipNote = (id: string) =>
    usage ? (
      <div class="leaf-tip" id={id} role="tooltip">
        <p class="leaf-tip-phrase">{leaf!.phrase}</p>
        <p class="leaf-tip-line">{leaf!.line}</p>
        <p class="leaf-tip-count">
          About {Math.round(usage.used).toLocaleString("en-US")} used
          {" · "}
          {Math.max(0, Math.round(usage.ceiling - usage.used)).toLocaleString(
            "en-US",
          )}{" "}
          remain
        </p>
      </div>
    ) : null;
  const gmTurns = gmTurnsByIndex(state.story, state.successTurnCount);
  const scratchMap = scratchByTs(scratch);
  let cutIndex = -1;
  if (confirmTurn !== null) {
    for (const [i, t] of gmTurns) {
      if (t === confirmTurn) cutIndex = i;
    }
  }

  useEffect(() => {
    const el = playRef.current;
    if (!el || !autoScrollRef.current) return;
    el.scrollTop = el.scrollHeight;
    lastAutoScrollTopRef.current = el.scrollTop;
  }, [state.story, state.draft, state.phase, state.liveScratch, state.maintenanceScratch]);

  // a picture that finishes loading late must not strand a following reader
  const followAfterLoad = () => {
    const el = playRef.current;
    if (!el || !autoScrollRef.current) return;
    el.scrollTop = el.scrollHeight;
    lastAutoScrollTopRef.current = el.scrollTop;
  };

  const trackAutoScroll = () => {
    const el = playRef.current;
    if (!el) return;
    if (atBottom(el)) {
      autoScrollRef.current = true;
      lastAutoScrollTopRef.current = el.scrollTop;
      return;
    }
    const lastAutoScrollTop = lastAutoScrollTopRef.current;
    if (
      autoScrollRef.current &&
      lastAutoScrollTop !== null &&
      el.scrollTop >= lastAutoScrollTop - 1
    ) {
      return;
    }
    autoScrollRef.current = false;
  };

  useEffect(() => {
    if (!editing) return;
    editRef.current?.focus();
  }, [editing ? editing.ts : ""]);

  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setConfirmTurn(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming]);

  useEffect(() => {
    if (illustrating) setLooking(null);
  }, [illustrating]);

  const dismissEasel = () => {
    setLooking(null);
    onDismissEasel?.();
  };

  useEffect(() => {
    if ((!looking && !illustrating) || confirming || editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Esc") return;
      e.preventDefault();
      dismissEasel();
    };
    window.addEventListener("keydown", onKey, true);
    easelRef.current
      ?.querySelector<HTMLButtonElement>(".easel-actions button")
      ?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [looking, illustrating, confirming, editing]);

  const send = () => {
    if (!canSend) return;
    const text = composeText;
    const followedBeforeSubmit = autoScrollRef.current;
    autoScrollRef.current = true;
    lastAutoScrollTopRef.current =
      playRef.current?.scrollTop ?? lastAutoScrollTopRef.current;
    void Promise.resolve(onSubmit(text)).then(
      (ok) => {
        if (ok === false) {
          autoScrollRef.current = followedBeforeSubmit;
          return;
        }
        setComposeText("");
      },
      () => {
        autoScrollRef.current = followedBeforeSubmit;
      },
    );
  };

  const easel = illustrating ?? looking;

  return (
    <div class={`a${railOpen ? " rail-open" : ""}`}>
      {easel ? (
        <div ref={easelRef}>
          <Easel
            prompt={easel.prompt}
            src={easel.src}
            busy={authoring}
            scratch={"scratch" in easel ? easel.scratch : undefined}
            candidates={"candidates" in easel ? easel.candidates : undefined}
            onLeave={dismissEasel}
            onPick={
              onPickIllustration
                ? (slot) => {
                    void onPickIllustration(slot);
                  }
                : undefined
            }
            onRegenerate={
              onIllustrate
                ? (prompt) => {
                    setLooking(null);
                    void onIllustrate(prompt);
                  }
                : undefined
            }
          />
        </div>
      ) : null}
      <div class={`ink-cluster${leafTip ? " is-tip" : ""}`}>
        {brush("brush")}
        {inkwell("leaf-tip")}
        {leafTipNote("leaf-tip")}
      </div>
      <div class="book">
        <div class="book-flip" aria-hidden="true">
          <div class="book-flip-face book-flip-front" />
          <div class="book-flip-face book-flip-back" />
        </div>
        <section class="page verso">
          <header class="page-head">
            <div class="page-actions page-actions-start">
              {onLeave ? (
                <button type="button" class="leave" onClick={onLeave}>
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M12.5 4.5 7 10l5.5 5.5" />
                  </svg>
                  Contents
                </button>
              ) : null}
            </div>
            <span class="page-title">
              {campaignName}
              {state.successTurnCount > 0
                ? ` · ${romanTurn(state.successTurnCount)}`
                : ""}
            </span>
            <div class={`desk-mini${leafTip ? " is-tip" : ""}`}>
              {brush("desk-mini-brush")}
              {inkwell("leaf-tip-mini")}
              {leafTipNote("leaf-tip-mini")}
            </div>

            <div class="page-actions">
              <button
                type="button"
                class="rail-toggle"
                onClick={() => setRailOpen(true)}
              >
                The other leaf
              </button>
              {onReadLocalLog ? (
                <button
                  type="button"
                  class="log-toggle"
                  aria-expanded={localLogOpen}
                  onClick={() => setLocalLogOpen((open) => !open)}
                >
                  AI log
                </button>
              ) : null}
            </div>
          </header>
          <div class="play" ref={playRef} onScroll={trackAutoScroll}>
            {state.maintenanceScratch && maintenanceAfter === 0 ? (
              <MaintenanceScratchPane
                scratch={state.maintenanceScratch}
                onEndReasoning={
                  canEndReasoning ? onEndReasoning : undefined
                }
              />
            ) : null}
            {state.story.map((b, i) => {
              const key = rowKey(b.ts, i);
              const record = b.ts ? scratchMap.get(b.ts) : undefined;
              const scratchOpen = Boolean(record && openScratch === key);
              const liveOnThis =
                liveOpen && extending && i === latestStory && b.role === "gm";
              const hit = hoverKey === key || focusKey === key;
              const turn = gmTurns.get(i);
              const isEditing = Boolean(editing && editing.ts === b.ts);
              const afterCut = cutIndex >= 0 && i > cutIndex;
              const previous = state.story[i - 1];
              return (
                <Fragment key={b.ts ?? i}>
                  <article
                    class={`story-block ${b.role}${settledRef.current.has(b.ts ?? String(i)) ? " settled" : ""}${i === latestStory && !draftLatest ? " latest" : ""}${scratchOpen || liveOnThis ? " is-open" : ""}${isEditing ? " is-editing" : ""}${afterCut ? " after-cut" : ""}`}
                  onMouseEnter={() => setHoverKey(key)}
                  onMouseLeave={() =>
                    setHoverKey((cur) => (cur === key ? null : cur))
                  }
                  onClick={(e) => {
                    const el = e.target as HTMLElement;
                    if (el.closest("button, textarea, a, .tip-in")) return;
                    setHoverKey((cur) => (cur === key ? null : key));
                    setFocusKey(key);
                  }}
                >
                  {liveOnThis && state.liveScratch ? (
                    <ScratchPane
                      thinking={state.liveScratch.thinking}
                      tools={state.liveScratch.tools}
                      live
                      cycleKey={`turn:${state.liveScratch.tools.length}`}
                      onEndReasoning={
                        canEndReasoning ? onEndReasoning : undefined
                      }
                    />
                  ) : scratchOpen && record ? (
                    <ScratchPane
                      thinking={record.thinking}
                      tools={record.tools}
                      busy={locked}
                      onContinueFrom={
                        // the latest Turn only, as Retry
                        canEditScratch &&
                        i === latestStory &&
                        b.role === "gm" &&
                        previous?.role === "player"
                          ? (thinking) => onRetryTranscript?.(b.ts!, thinking)
                          : undefined
                      }
                    />
                  ) : null}
                  <div class="who">
                    <span
                      class="who-hit"
                      tabIndex={0}
                      onMouseEnter={() => setHoverKey(key)}
                      onFocus={() => setFocusKey(key)}
                      onBlur={(e) => {
                        const root = e.currentTarget.closest(".story-block");
                        const next = e.relatedTarget as Node | null;
                        if (next && root?.contains(next)) return;
                        queueMicrotask(() => {
                          if (!root?.isConnected) return;
                          if (root.contains(document.activeElement)) return;
                          setFocusKey((cur) => (cur === key ? null : cur));
                        });
                      }}
                    >
                      {b.role === "gm" ? "GM" : "You"}
                      <WhoChip
                        reveal={hit && !isEditing && confirmTurn !== turn}
                        scratchOpen={scratchOpen}
                        busy={locked}
                        isGm={b.role === "gm"}
                        isLast={i === latestStory}
                        hasScratch={Boolean(record)}
                        onEdit={
                          b.ts
                            ? () => setEditing({ ts: b.ts!, text: b.text })
                            : undefined
                        }
                        onContinue={
                          b.role === "gm" && turn !== undefined
                            ? () => setConfirmTurn(turn)
                            : undefined
                        }
                        onScratch={
                          record
                            ? () =>
                                setOpenScratch((cur) =>
                                  cur === key ? null : key,
                                )
                            : undefined
                        }
                        onRetry={
                          i === latestStory &&
                          b.ts &&
                          // a Turn, or a message whose Turn failed without a reply
                          (b.role === "player" ||
                            (b.role === "gm" && previous?.role === "player"))
                            ? () => {
                                void onRetryTranscript?.(b.ts!);
                              }
                            : undefined
                        }
                        onDelete={
                          i === latestStory
                            ? () => {
                                void onDeleteTranscript?.(b.ts);
                              }
                            : undefined
                        }
                      />
                    </span>
                  </div>
                  <hr class="rule" />
                  {isEditing && editing ? (
                    <>
                      <label class="sr-only" for="edit-row">
                        edit row
                      </label>
                      <textarea
                        id="edit-row"
                        class="prose-edit"
                        ref={editRef}
                        autofocus
                        value={editing.text}
                        disabled={busy}
                        onInput={(e) =>
                          setEditing({
                            ...editing,
                            text: (e.target as HTMLTextAreaElement).value,
                          })
                        }
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
                          disabled={busy}
                          onClick={() => {
                            if (!editing || busy) return;
                            void Promise.resolve(
                              onEditTranscript?.(editing.ts, editing.text),
                            ).then((ok) => {
                              if (ok !== false) setEditing(null);
                            });
                          }}
                        >
                          Keep this line
                        </button>
                      </p>
                    </>
                  ) : extending && i === latestStory && b.role === "gm" ? (
                    <RevealProse
                      text={b.text}
                      streaming
                      startLines="initial"
                      onProgress={(n) => {
                        revealLinesRef.current = n;
                      }}
                      onGrow={followAfterLoad}
                    />
                  ) : handoffRef.current?.key === (b.ts ?? String(i)) ? (
                    <RevealProse
                      text={b.text}
                      streaming={false}
                      startLines={handoffRef.current.lines}
                      onGrow={followAfterLoad}
                      onDone={() => {
                        handoffRef.current = null;
                      }}
                    />
                  ) : (
                    <div class="prose">{b.text}</div>
                  )}
                  {b.illustration && !isEditing ? (
                    <IllustrationFrame
                      src={`/api/illustrations/${encodeURIComponent(b.illustration)}?v=${illustrateTick}`}
                      onLoad={followAfterLoad}
                      onOpen={() => {
                        if (illustrating) return;
                        const src = `/api/illustrations/${encodeURIComponent(b.illustration!)}?v=${illustrateTick}`;
                        setLooking({
                          src,
                          prompt:
                            b.illustrationPrompt ??
                            sittingPrompts[b.illustration!],
                        });
                      }}
                    />
                  ) : null}
                  {b.ts && b.ts === unansweredTs && !isEditing ? (
                    <aside class="unanswered" role="status">
                      <p>
                        {state.lastError ??
                          "The Game Master has not answered this yet."}
                      </p>
                      <p class="ink-actions">
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() => {
                            void onRetryTranscript?.(b.ts!);
                          }}
                        >
                          Try again
                        </button>
                      </p>
                    </aside>
                  ) : null}
                  {confirmTurn !== null && turn === confirmTurn ? (
                    <aside class="tip-in" role="alertdialog">
                      <p>
                        Continue from this line? Everything after it is cut
                        from the play.
                      </p>
                      <p class="ink-actions">
                        <button
                          type="button"
                          onClick={() => setConfirmTurn(null)}
                        >
                          Leave it
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            const next = confirmTurn;
                            setConfirmTurn(null);
                            if (next !== null) void onContinue?.(next);
                          }}
                        >
                          Continue from here
                        </button>
                      </p>
                    </aside>
                  ) : null}
                </article>
                  {state.maintenanceScratch &&
                  maintenanceAfter === i + 1 ? (
                    <MaintenanceScratchPane
                      scratch={state.maintenanceScratch}
                      onEndReasoning={
                        canEndReasoning ? onEndReasoning : undefined
                      }
                    />
                  ) : null}
                </Fragment>
              );
            })}
            {draftLatest || liveOnDraft ? (
              <article
                class={`story-block gm draft latest${liveOnDraft ? " is-open" : ""}`}
              >
                {liveOnDraft && state.liveScratch ? (
                  <ScratchPane
                    thinking={state.liveScratch.thinking}
                    tools={state.liveScratch.tools}
                    live
                    cycleKey={`turn:${state.liveScratch.tools.length}`}
                    onEndReasoning={
                      canEndReasoning ? onEndReasoning : undefined
                    }
                  />
                ) : null}
                <div class="who">GM</div>
                <hr class="rule" />
                {state.draft ? (
                  <RevealProse
                    text={state.draft}
                    streaming
                    onProgress={(n) => {
                      revealLinesRef.current = n;
                    }}
                    onGrow={followAfterLoad}
                  />
                ) : (
                  <div
                    class="prose mute quill-wait"
                    role="status"
                    aria-label="The Game Master is writing"
                  >
                    <QuillIcon class="quill-wait-icon" />
                    <span class="quill-wait-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                )}
              </article>
            ) : null}
            {confirming &&
            ![...gmTurns.entries()].some(([, t]) => t === confirmTurn) ? (
              <aside class="tip-in" role="alertdialog">
                <p>
                  Continue from this line? Everything after it is cut from the
                  play.
                </p>
                <p class="ink-actions">
                  <button type="button" onClick={() => setConfirmTurn(null)}>
                    Leave it
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const next = confirmTurn;
                      setConfirmTurn(null);
                      if (next !== null) void onContinue?.(next);
                    }}
                  >
                    Continue from here
                  </button>
                </p>
              </aside>
            ) : null}
          </div>
          {status.text ? (
            <div class={`status-line ${status.kind}`}>
              {status.text}
            </div>
          ) : null}
          {localLogOpen && onReadLocalLog ? (
            <LocalLogDrawer read={onReadLocalLog} />
          ) : null}
          <form
            class={`composer${busy ? " is-busy" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <QuillIcon class="compose-quill" />
            <textarea
              rows={1}
              aria-label="What do you do?"
              autofocus={!editing && !confirming}
              disabled={locked}
              placeholder={busy ? "…" : "What do you do?"}
              value={composeText}
              onInput={(e) => {
                setComposeText((e.target as HTMLTextAreaElement).value);
                props.onComposeInput?.();
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                if (e.shiftKey || e.ctrlKey || e.metaKey) return;
                e.preventDefault();
                send();
              }}
            />
            {busy ? (
              <button type="button" class="compose-stop" onClick={onInterrupt}>
                <span class="compose-stop-mark" aria-hidden="true" />
                Stop
              </button>
            ) : (
              <button type="submit" class="compose-seal" disabled={!canSend}>
                <span class="compose-seal-wax" aria-hidden="true" />
                <span class="compose-seal-label">Play</span>
              </button>
            )}
          </form>
        </section>
        <InspectPage
          inspect={inspect}
          locked={locked}
          history={history}
          scratch={scratch}
          usage={usage}
          playSettings={playSettings}
          fixedSettings={fixedSettings}
          onInspect={onInspect}
          onSaveInspect={onSaveInspect}
          onCreateDossier={onCreateDossier}
          onArchiveDossier={onArchiveDossier}
          onHygiene={onHygiene}
          onLuck={onLuck}
          onSavePlaySettings={onSavePlaySettings}
          onCloseRail={() => setRailOpen(false)}
          onConfirmContinue={setConfirmTurn}
        />
      </div>
    </div>
  );
}
