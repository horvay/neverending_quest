import { useEffect, useLayoutEffect, useRef } from "preact/hooks";

/**
 * Prose that arrives in bursts but reads smoothly: text is laid out as it
 * streams in, and whole lines fade in one after another on the book's own
 * clock. Only finished lines are shown (the last one is still being written),
 * so a word never lands mid-line. The pace follows the backlog, which keeps
 * it right for any model: a burst of several lines drains quickly, a slow
 * model shows each line as it completes, and a line that stays unfinished
 * for a while is wiped in word by word so the page never sits still.
 *
 * Lines are found from the laid-out text (so wrapping, width and font size
 * are the browser's own) and revealed with a CSS mask, one layer per line.
 * Where there is no layout (tests without a renderer) or the reader prefers
 * reduced motion, the text simply shows.
 */

/** How long one line takes to fade in. */
const FADE_MS = 520;
/** Gap between line starts with one line waiting; more waiting, shorter gaps. */
const LINE_GAP_MS = 240;
const MIN_LINE_GAP_MS = 55;
/** An unfinished line waits this long for its end before it is wiped in. */
const PARTIAL_AFTER_MS = 1200;
/** How fast a wiped-in partial line follows its words, in px per second. */
const WIPE_PX_PER_S = 520;
const WIPE_EDGE_PX = 28;

type Row = { top: number; bottom: number; right: number };

type RevealState = {
  /** Start time of each line's fade, by line index. */
  starts: number[];
  lastStart: number;
  /** When the most recent line became complete. */
  lastComplete: number;
  completeSeen: number;
  /** Wiped-in width of the unfinished last line, if it is showing. */
  partial: { index: number; width: number; start: number } | null;
  raf: number;
  lastTick: number;
  done: boolean;
};

export type RevealProseProps = {
  text: string;
  /** More text is still coming. */
  streaming: boolean;
  /**
   * Lines already on the page before this reveal: "initial" treats all
   * lines of the first text as shown (a reply being extended); a number
   * continues a reveal that another element started.
   */
  startLines?: number | "initial";
  /** Lines fully shown so far, for a later element to continue from. */
  onProgress?: (lines: number) => void;
  /** The shown text grew; a reader following the story may scroll. */
  onGrow?: () => void;
  /** Every line is shown and the stream has ended. */
  onDone?: () => void;
  class?: string;
};

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/** Visual lines of the element's text, relative to its top edge. */
function measureRows(el: HTMLElement): Row[] {
  const range = document.createRange();
  range.selectNodeContents(el);
  const base = el.getBoundingClientRect();
  const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0 && r.width >= 0);
  if (rects.length === 0) return [];
  const heights = rects.map((r) => r.height).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)]!;
  const rows: Row[] = [];
  for (const r of rects) {
    // a drop cap or other tall box spans several lines; the lines themselves decide
    if (r.height > typical * 1.6) continue;
    const top = r.top - base.top;
    const row = rows.find((x) => Math.abs(x.top - top) < typical / 2);
    if (row) {
      row.bottom = Math.max(row.bottom, r.bottom - base.top);
      row.right = Math.max(row.right, r.right - base.left);
    } else {
      rows.push({ top, bottom: r.bottom - base.top, right: r.right - base.left });
    }
  }
  rows.sort((a, b) => a.top - b.top);
  return rows;
}

function layer(alpha: number, top: number, height: number, width?: number): {
  image: string;
  position: string;
  size: string;
} {
  const a = Math.max(0, Math.min(1, alpha)).toFixed(3);
  if (width === undefined) {
    return {
      image: `linear-gradient(rgba(0,0,0,${a}),rgba(0,0,0,${a}))`,
      position: `0 ${top.toFixed(1)}px`,
      size: `100% ${height.toFixed(1)}px`,
    };
  }
  return {
    image: `linear-gradient(to right, rgba(0,0,0,${a}) calc(100% - ${WIPE_EDGE_PX}px), rgba(0,0,0,0))`,
    position: `0 ${top.toFixed(1)}px`,
    size: `${width.toFixed(1)}px ${height.toFixed(1)}px`,
  };
}

export function RevealProse(props: RevealProseProps) {
  const ref = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const stateRef = useRef<RevealState | null>(null);
  const plain = useRef(reducedMotion());

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || plain.current) return;
    const rows = measureRows(el);
    if (rows.length === 0 && props.text.length > 0) {
      // no layout to measure: show the text as is
      plain.current = true;
      return;
    }
    if (!stateRef.current) {
      el.style.setProperty("text-wrap", "wrap");
      const now = performance.now();
      const shown =
        props.startLines === "initial"
          ? rows.length
          : Math.min(props.startLines ?? 0, rows.length);
      stateRef.current = {
        // lines already shown start fully faded in
        starts: Array.from({ length: shown }, () => now - FADE_MS),
        lastStart: now - LINE_GAP_MS,
        lastComplete: now,
        completeSeen: shown,
        partial: null,
        raf: 0,
        lastTick: now,
        done: false,
      };
    }
    const s = stateRef.current;
    if (!s.raf && !s.done) {
      s.raf = requestAnimationFrame(tick);
    } else if (s.done && props.streaming) {
      s.done = false;
      s.raf = requestAnimationFrame(tick);
    }
  });

  useEffect(
    () => () => {
      const s = stateRef.current;
      if (s?.raf) cancelAnimationFrame(s.raf);
    },
    [],
  );

  function finish(el: HTMLElement, s: RevealState) {
    for (const prop of [
      "mask-image",
      "-webkit-mask-image",
      "mask-position",
      "-webkit-mask-position",
      "mask-size",
      "-webkit-mask-size",
      "mask-repeat",
      "-webkit-mask-repeat",
      "height",
      "overflow",
      "text-wrap",
    ]) {
      el.style.removeProperty(prop);
    }
    s.done = true;
    s.raf = 0;
    propsRef.current.onProgress?.(s.starts.length);
    propsRef.current.onDone?.();
  }

  function tick(now: number) {
    const el = ref.current;
    const s = stateRef.current;
    if (!el || !s) return;
    const p = propsRef.current;
    const rows = measureRows(el);
    const complete = p.streaming ? Math.max(0, rows.length - 1) : rows.length;
    if (complete > s.completeSeen) {
      s.completeSeen = complete;
      s.lastComplete = now;
    }

    const dt = Math.max(0, now - s.lastTick) / 1000;
    // a line that stays unfinished is wiped in behind its words
    const last = rows.length - 1;
    if (
      !s.partial &&
      p.streaming &&
      complete <= s.starts.length &&
      last >= s.starts.length &&
      now - s.lastComplete > PARTIAL_AFTER_MS
    ) {
      s.partial = { index: last, width: 0, start: now };
    }
    if (s.partial) {
      const row = rows[s.partial.index];
      if (row) {
        s.partial.width = Math.min(row.right + WIPE_EDGE_PX, s.partial.width + WIPE_PX_PER_S * dt);
      }
    }

    // start the next line when its turn comes; a longer queue drains faster
    const waiting = complete - s.starts.length;
    if (waiting > 0) {
      const gap = Math.max(MIN_LINE_GAP_MS, LINE_GAP_MS / waiting);
      const next = s.starts.length;
      const wiping = s.partial?.index === next ? s.partial : null;
      if (wiping) {
        // a line wiped in while unfinished finishes its wipe instead of a second fade
        const row = rows[next];
        if (!row || wiping.width >= row.right + WIPE_EDGE_PX) {
          s.starts.push(wiping.start);
          s.partial = null;
          s.lastStart = now;
        }
      } else if (now - s.lastStart >= gap) {
        s.starts.push(now);
        s.lastStart = now;
      }
    }
    s.lastTick = now;

    // one mask layer per visible line; fully faded lines merge into one
    const layers: Array<ReturnType<typeof layer>> = [];
    let solidTo = 0;
    let shownBottom = 0;
    for (let i = 0; i < s.starts.length && i < rows.length; i++) {
      const row = rows[i]!;
      const nextTop = rows[i + 1]?.top ?? row.bottom;
      const bottom = Math.max(row.bottom, nextTop);
      const alpha = (now - s.starts[i]!) / FADE_MS;
      shownBottom = Math.max(shownBottom, row.bottom);
      if (alpha >= 1 && solidTo >= row.top - 1) {
        solidTo = bottom;
        continue;
      }
      layers.push(layer(alpha, row.top, bottom - row.top));
    }
    if (solidTo > 0) layers.unshift(layer(1, 0, solidTo));
    if (s.partial && rows[s.partial.index]) {
      const row = rows[s.partial.index]!;
      const alpha = (now - s.partial.start) / FADE_MS;
      layers.push(layer(alpha, row.top, row.bottom - row.top + 2, s.partial.width));
      shownBottom = Math.max(shownBottom, row.bottom);
    }

    const allShown =
      !p.streaming && s.starts.length >= rows.length && s.starts.every((t) => now - t >= FADE_MS);
    if (allShown) {
      finish(el, s);
      return;
    }
    const empty = "linear-gradient(transparent,transparent)";
    const image = layers.length ? layers.map((l) => l.image).join(",") : empty;
    el.style.setProperty("mask-image", image);
    el.style.setProperty("-webkit-mask-image", image);
    el.style.setProperty("mask-position", layers.map((l) => l.position).join(",") || "0 0");
    el.style.setProperty("-webkit-mask-position", layers.map((l) => l.position).join(",") || "0 0");
    el.style.setProperty("mask-size", layers.map((l) => l.size).join(",") || "0 0");
    el.style.setProperty("-webkit-mask-size", layers.map((l) => l.size).join(",") || "0 0");
    el.style.setProperty("mask-repeat", "no-repeat");
    el.style.setProperty("-webkit-mask-repeat", "no-repeat");
    // the page grows line by line instead of holding blank space for hidden text
    el.style.overflow = "hidden";
    // "pretty" wrapping rebalances a paragraph's last lines as words arrive,
    // which would move words between lines already shown
    el.style.setProperty("text-wrap", "wrap");
    const height = `${Math.ceil(shownBottom)}px`;
    if (el.style.height !== height) {
      el.style.height = height;
      p.onGrow?.();
    }
    p.onProgress?.(s.starts.filter((t) => now - t >= FADE_MS).length);
    s.raf = requestAnimationFrame(tick);
  }

  return (
    <div ref={ref} class={props.class ?? "prose"}>
      {props.text}
    </div>
  );
}
