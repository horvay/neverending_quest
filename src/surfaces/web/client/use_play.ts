import { useEffect, useRef, useState } from "preact/hooks";
import { applyPlayEvent, createKernel, type KernelState } from "../../../play/kernel.ts";
import type { ManualHygieneMode, PlayEvent } from "../../../play/types.ts";
import type { HomeView } from "../api.ts";
import { api, isStale } from "./api_client.ts";
import type {
  BookAppProps,
  HistoryEntry,
  InspectView,
  ScratchView,
} from "./book.tsx";

/** One `/api/events` connection: a KernelState line, then a PlayEvent per line. */
async function consumeEvents(
  onSnapshot: (s: KernelState) => void,
  onEvent: (e: PlayEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await api.events(signal);
  // 409: nothing open (the adventure was just left); retry after a pause
  if (!res.ok) throw new Error(`events ${res.status}`);
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as KernelState | PlayEvent;
      if (first) {
        onSnapshot(obj as KernelState);
        first = false;
      } else {
        onEvent(obj as PlayEvent);
      }
    }
  }
}

/** Follow the event stream, reconnecting after drops, until `signal` aborts. */
async function watchEvents(
  onSnapshot: (s: KernelState) => void,
  onEvent: (e: PlayEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await consumeEvents(onSnapshot, onEvent, signal);
    } catch {
      if (signal.aborted) return;
    }
    // Always pause before reconnecting. In the hosted book /api/events is
    // answered inside the page, so an instant retry never yields to the UI.
    await new Promise((r) => setTimeout(r, 250));
  }
}

function inspectErrorMessage(status: number, kind: "save" | "create"): string {
  if (status === 409) {
    return kind === "create"
      ? "A dossier with that slug already exists."
      : "Busy — try again when Idle.";
  }
  if (status === 400) return kind === "create" ? "Invalid slug." : "Could not save.";
  if (status === 404) return "That file cannot be written.";
  return "Could not save.";
}

const BUSY = "Busy — try again when Idle.";

/** Play commands the book calls that this hook answers. */
type PlayCommands = Pick<
  BookAppProps,
  | "onSubmit"
  | "onInterrupt"
  | "onInspect"
  | "onSaveInspect"
  | "onCreateDossier"
  | "onArchiveDossier"
  | "onHygiene"
  | "onLuck"
  | "onEditTranscript"
  | "onDeleteTranscript"
  | "onRetryTranscript"
  | "onContinue"
  | "onEndReasoning"
  | "onReadLocalLog"
>;

/**
 * The open adventure: the Play Kernel folded from `/api/events`, the Inspect
 * leaf, Scratch and history, and the commands the book sends. Every handler
 * checks it is still mounted, so nothing fetches after the book is gone.
 */
export function usePlay(opts: {
  playing: boolean;
  home: HomeView | null | undefined;
  /** Sees every PlayEvent after the kernel has. */
  onEvent: (ev: PlayEvent) => void;
}) {
  const [state, setState] = useState(() => createKernel());
  const [inspect, setInspect] = useState<InspectView>({ target: "quests", text: "" });
  const [statusName, setStatusName] = useState<string | undefined>();
  const [authoring, setAuthoring] = useState(false);
  const [scratch, setScratch] = useState<ScratchView[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [notice, setNotice] = useState("");
  const inspectRef = useRef(inspect);
  inspectRef.current = inspect;
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;
  /** The manual hygiene pass in flight, until its ended event. */
  const hygieneLock = useRef<ManualHygieneMode | null>(null);
  /** Aborted when the book unmounts or the adventure closes. */
  const live = useRef<AbortSignal | null>(null);
  const alive = () => live.current !== null && !live.current.aborted;

  async function loadScratch() {
    const reply = await api.scratch();
    if (reply.ok && alive()) setScratch(reply.body.records);
  }

  async function loadHistory() {
    const reply = await api.history();
    if (reply.ok && alive()) setHistory(reply.body.entries);
  }

  async function loadInspect(target: string, slug?: string) {
    // the Settings leaf is the book's own page, not a Campaign file
    if (target === "settings") {
      setInspect({ target, text: "" });
      return;
    }
    const reply = await api.inspect(target, slug);
    if (!reply.ok || !alive()) return;
    const leaf = reply.body;
    setInspect({
      target,
      text: leaf.text,
      hash: leaf.hash,
      slug,
      ...("entries" in leaf ? { entries: leaf.entries } : {}),
      ...("archived" in leaf ? { archived: leaf.archived } : {}),
    });
  }

  function reloadLeaves() {
    const cur = inspectRef.current;
    void loadInspect(cur.target, cur.slug);
    void loadScratch();
    void loadHistory();
  }

  function onPlayEvent(ev: PlayEvent) {
    setState((s) => applyPlayEvent(s, ev));
    if (ev.type === "compact_ended") {
      hygieneLock.current = null;
      setAuthoring(false);
    } else if (
      ev.type === "hygiene_ended" &&
      hygieneLock.current !== "compact" &&
      hygieneLock.current !== "fresh"
    ) {
      hygieneLock.current = null;
      setAuthoring(false);
    }
    if (
      ev.type === "turn_started" ||
      ev.type === "hygiene_started" ||
      ev.type === "compact_started"
    ) {
      setNotice("");
    }
    if (ev.type === "turn_ended") setAuthoring(false);
    if (
      ev.type === "turn_ended" ||
      ev.type === "hygiene_ended" ||
      ev.type === "compact_ended" ||
      ev.type === "story_replaced"
    ) {
      reloadLeaves();
    }
    onEventRef.current(ev);
  }

  useEffect(() => {
    if (!opts.playing) {
      setState(createKernel());
      setNotice("");
      return;
    }
    const ac = new AbortController();
    live.current = ac.signal;
    void watchEvents(
      (snap) => {
        if (!ac.signal.aborted) setState(snap);
      },
      (ev) => {
        if (!ac.signal.aborted) onPlayEvent(ev);
      },
      ac.signal,
    );
    void loadInspect("quests");
    void loadScratch();
    void loadHistory();
    const onFocus = () => reloadLeaves();
    window.addEventListener("focus", onFocus);
    void api.inspect("status").then((reply) => {
      const m = reply.ok ? reply.body.text.match(/^name: (.+)$/m) : null;
      if (m?.[1] && !ac.signal.aborted) setStatusName(m[1]);
    });
    return () => {
      ac.abort();
      live.current = null;
      window.removeEventListener("focus", onFocus);
    };
  }, [opts.playing]);

  /** Lock the book while a write is in flight. */
  async function authored<T>(run: () => Promise<T>): Promise<T> {
    setAuthoring(true);
    try {
      return await run();
    } finally {
      setAuthoring(false);
    }
  }

  function sameLeaf(view: InspectView, target: string, slug?: string): boolean {
    return view.target === target && view.slug === slug;
  }

  async function saveInspect(text: string) {
    const cur = inspectRef.current;
    if (!cur.hash) return;
    const { target, slug } = cur;
    await authored(async () => {
      const reply = await api.saveInspect(target, slug, text, cur.hash!);
      if (!alive() || !sameLeaf(inspectRef.current, target, slug)) return;
      if (reply.ok) {
        await loadInspect(target, slug);
        return;
      }
      if (reply.status === 409 && isStale(reply.body)) {
        setInspect({
          ...inspectRef.current,
          text: reply.body.text,
          hash: reply.body.hash ?? cur.hash,
          stale: true,
          error: undefined,
        });
        return;
      }
      setInspect({
        ...inspectRef.current,
        stale: false,
        error: inspectErrorMessage(reply.status, "save"),
      });
    });
  }

  async function fireHygiene(mode: ManualHygieneMode) {
    hygieneLock.current = mode;
    setAuthoring(true);
    const reply = await api.hygiene(mode);
    // 202 is accept-only; stay locked until hygiene_ended / compact_ended
    if (!reply.ok) {
      hygieneLock.current = null;
      setAuthoring(false);
    }
  }

  async function setLuck(armed: boolean) {
    setNotice("");
    await authored(async () => {
      const reply = await api.luck(armed);
      if (!reply.ok) {
        setNotice(reply.status === 409 ? BUSY : "Could not change Luck Points.");
        return;
      }
      if (inspectRef.current.target === "status") await loadInspect("status");
    });
  }

  async function archiveDossier(slug: string, archive: boolean) {
    const cur = inspectRef.current;
    await authored(async () => {
      const reply = await api.archiveDossier(slug, archive);
      if (!reply.ok) {
        if (cur.target === "dossiers") {
          setInspect({
            ...inspectRef.current,
            error: inspectErrorMessage(reply.status, "save"),
          });
        }
        return;
      }
      if (inspectRef.current.target !== "dossiers") return;
      await loadInspect("dossiers", inspectRef.current.slug);
    });
  }

  async function createDossier(slug: string) {
    await authored(async () => {
      const reply = await api.createDossier(slug);
      const stillIndex =
        inspectRef.current.target === "dossiers" && !inspectRef.current.slug;
      if (!reply.ok) {
        if (stillIndex) {
          setInspect({
            ...inspectRef.current,
            error: inspectErrorMessage(reply.status, "create"),
          });
        }
        return;
      }
      if (stillIndex) await loadInspect("dossiers", slug);
    });
  }

  /** Start a background command (Retry, Continue): the book stays locked until its events. */
  async function begin(
    run: () => ReturnType<typeof api.retry>,
    failure: (status: number) => string,
  ): Promise<boolean> {
    setNotice("");
    setAuthoring(true);
    const reply = await run();
    if (!reply.ok) {
      setAuthoring(false);
      setNotice(reply.status === 409 ? BUSY : failure(reply.status));
    }
    return reply.ok;
  }

  const commands: PlayCommands = {
    onSubmit: async (text) => {
      setNotice("");
      return (await api.turn(text)).ok;
    },
    onInterrupt: () => void api.interrupt(),
    onInspect: (target, slug) => void loadInspect(target, slug),
    onSaveInspect: (text) => void saveInspect(text),
    onCreateDossier: (slug) => void createDossier(slug),
    onArchiveDossier: (slug, archive) => void archiveDossier(slug, archive),
    onHygiene: (mode) => {
      setNotice("");
      void fireHygiene(mode);
    },
    onLuck: (armed) => void setLuck(armed),
    onEditTranscript: (ts, text) => authored(async () => (await api.editTranscript(ts, text)).ok),
    onDeleteTranscript: (ts) => authored(async () => (await api.deleteTranscript(ts)).ok),
    onRetryTranscript: (ts, thinking) =>
      begin(
        () => api.retry(ts, thinking),
        (status) =>
          status === 404
            ? "Only the latest Game Master reply can be retried."
            : status === 422
              ? "This Game Master cannot continue from edited scratch."
              : "Could not retry this reply.",
      ),
    onContinue: (turn) =>
      begin(
        () => api.continueFrom(turn),
        (status) =>
          status === 404 ? "That line is not on the current play." : "Could not continue.",
      ),
    onEndReasoning: async () => {
      const reply = await api.endReasoning();
      if (reply.ok) return true;
      if (reply.status !== 409) setNotice("Could not end local reasoning.");
      return false;
    },
    ...(opts.home?.diagnostics === false
      ? {}
      : {
          onReadLocalLog: async (source, offset, file) => {
            const reply = await api.localLog({
              source,
              ...(offset !== undefined ? { offset } : {}),
              ...(file ? { file } : {}),
            });
            if (!reply.ok) throw new Error(`Local log request failed: ${reply.status}`);
            return reply.body;
          },
        }),
  };

  return {
    state,
    inspect,
    scratch,
    history,
    authoring,
    setAuthoring,
    notice,
    setNotice,
    campaignName: opts.home?.open?.name ?? statusName ?? "Campaign",
    commands,
  };
}
