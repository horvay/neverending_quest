import { useEffect, useRef, useState } from "preact/hooks";
import type { PlayEvent } from "../../../play/types.ts";
import { illustrationPath } from "../api.ts";
import { api, type Reply } from "./api_client.ts";
import type { BookAppProps, IllustratingView } from "./book.tsx";

function failMessage(reply: Reply<unknown>): string {
  if (!reply.ok && reply.error) return reply.error;
  if (reply.status === 409) return "Busy — try again when Idle.";
  if (reply.status === 404) return "No Game Master row to illustrate.";
  if (reply.status === 503) return "Illustration runner is not installed.";
  if (reply.status === 422) return "Could not make an image prompt from this scene.";
  return "Could not illustrate this line.";
}

/** A fresh URL each time, so the book never shows a replaced picture from cache. */
const fresh = (ts: string, slot?: number) =>
  `${illustrationPath(ts, slot)}${slot === undefined ? "?" : "&"}v=${Date.now()}`;

/**
 * The easel: whether a painter exists, the sitting being painted (its rewrite
 * Scratch, prompt, and candidates as they land), and the kept picture.
 */
export function useIllustration(opts: {
  playing: boolean;
  setAuthoring: (on: boolean) => void;
  setNotice: (text: string) => void;
}) {
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);
  const [illustrating, setIllustrating] = useState<IllustratingView | null>(null);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const lock = useRef(false);

  useEffect(() => {
    if (!opts.playing) return;
    let live = true;
    void api.illustrationStatus().then((reply) => {
      if (live) setReady(reply.ok && reply.body.ready === true);
    });
    return () => {
      live = false;
    };
  }, [opts.playing]);

  function rememberPrompt(ts: string, prompt: string | undefined) {
    if (prompt?.trim()) setPrompts((cur) => ({ ...cur, [ts]: prompt }));
  }

  function onEvent(ev: PlayEvent) {
    switch (ev.type) {
      case "illustrate_started":
        setIllustrating((cur) => cur ?? { ts: ev.ts, candidates: [] });
        break;
      case "scratch_live":
        setIllustrating((cur) =>
          !cur || cur.src ? cur : { ...cur, scratch: { thinking: ev.thinking, tools: ev.tools } },
        );
        break;
      case "illustrate_prompt":
        rememberPrompt(ev.ts, ev.prompt);
        setIllustrating((cur) => ({ ...(cur ?? {}), ts: ev.ts, prompt: ev.prompt }));
        break;
      case "illustrate_candidate":
        setIllustrating((cur) => {
          if (!cur || cur.src) return cur;
          const next = [...(cur.candidates ?? [])];
          next[ev.slot] = fresh(ev.ts, ev.slot);
          return { ...cur, ts: ev.ts, candidates: next };
        });
        break;
      case "illustrate_picked":
        setTick((n) => n + 1);
        setIllustrating((cur) =>
          !cur && !ev.ts ? cur : { prompt: cur?.prompt, ts: ev.ts, src: fresh(ev.ts) },
        );
        break;
      case "illustrate_cancelled":
        setIllustrating((cur) => (cur?.src ? cur : null));
        break;
      case "illustrate_ended":
        if (!ev.ok) setIllustrating((cur) => (cur?.src ? cur : null));
        break;
    }
  }

  const props: Pick<
    BookAppProps,
    | "illustrationReady"
    | "illustrateTick"
    | "illustrating"
    | "sittingPrompts"
    | "onIllustrate"
    | "onPickIllustration"
    | "onDismissEasel"
  > = {
    illustrationReady: ready,
    illustrateTick: tick,
    illustrating,
    sittingPrompts: prompts,
    onDismissEasel: () => {
      setIllustrating(null);
      void api.cancelIllustration();
    },
    onPickIllustration: async (slot) => {
      const reply = await api.pickIllustration(slot);
      if (!reply.ok) {
        opts.setNotice(reply.status === 0 ? "Could not keep that sitting." : failMessage(reply));
        return;
      }
      const { ts, prompt } = reply.body;
      if (!ts) return;
      rememberPrompt(ts, prompt);
      setTick((n) => n + 1);
      setIllustrating((cur) => ({
        prompt: prompt?.trim() ? prompt : cur?.prompt,
        ts,
        src: fresh(ts),
      }));
    },
    onIllustrate: async (prompt) => {
      if (lock.current) return;
      lock.current = true;
      opts.setAuthoring(true);
      opts.setNotice("");
      const given = prompt?.trim();
      setIllustrating((cur) => ({ prompt: given || cur?.prompt, ts: cur?.ts, candidates: [] }));
      try {
        const reply = await api.illustrate(given);
        if (reply.ok) {
          const { ts, prompt: rewritten } = reply.body;
          if (typeof ts === "string") {
            rememberPrompt(ts, rewritten);
            setIllustrating((cur) =>
              cur ? { ...cur, ts, prompt: rewritten?.trim() ? rewritten : cur.prompt } : cur,
            );
          }
          return;
        }
        opts.setNotice(reply.status === 0 ? "Could not illustrate this line." : failMessage(reply));
        if (!given) setIllustrating((cur) => (cur?.src ? cur : null));
      } finally {
        lock.current = false;
        opts.setAuthoring(false);
      }
    },
  };

  return { onEvent, props };
}
