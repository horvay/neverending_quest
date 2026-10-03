/**
 * The hosted page's Game Master status: a pill at the top of the window (top
 * right beside two leaves, top centre over one, clear of the leaf's links) saying
 * whether the Game Master answers right now. It asks the relay's /status every
 * 15 s, at once when a call to the relay fails or the tab comes back into
 * view, and when tapped. A page that fell back to OpenRouter, or could not
 * start, offers a reload once the owner's computer answers again.
 */
import type { RelayStatus } from "../relay.ts";

/** What this page plays on: sealed calls (the owner's computer or Runpod), OpenRouter, or nothing yet. */
export type PageGameMaster = "sealed" | "openrouter" | "none";

type View = { tone: "online" | "backup" | "offline"; text: string; reload: boolean };

const RECHECK_MS = 15_000;
const COLORS = { online: "#2e9d57", backup: "#d4911c", offline: "#d14545" } as const;
/** One leaf on screen (the book's own breakpoint): centred and small, between Contents and the other leaf. */
const CSS = `
#nq-gm-status { top: 10px; right: 10px; gap: 8px; padding: 7px 14px; font: 600 14px/1.2 system-ui, sans-serif; }
#nq-gm-status > span:first-child { width: 12px; height: 12px; }
@media (max-width: 800px) {
  #nq-gm-status {
    top: max(2px, env(safe-area-inset-top, 0px));
    right: auto;
    left: 50%;
    transform: translateX(-50%);
    max-width: min(15rem, calc(100vw - 2rem));
    padding: 3px 10px;
    gap: 6px;
    font-size: 12px;
    text-align: center;
  }
  #nq-gm-status > span:first-child { width: 9px; height: 9px; }
}`;

export function badgeView(status: RelayStatus | null, using: PageGameMaster): View {
  if (!status) return { tone: "offline", text: "Can't reach the Game Master's server", reload: false };
  const answers = status.host !== "offline";
  if (using === "none") {
    return answers || status.backup
      ? { tone: "online", text: "Game Master is back · tap to reload", reload: true }
      : { tone: "offline", text: "Game Master offline · this will turn green when it's back", reload: false };
  }
  if (status.backend !== "local") return { tone: "online", text: "Game Master online", reload: false };
  if (using === "sealed") {
    return answers
      ? { tone: "online", text: "Game Master online", reload: false }
      : { tone: "offline", text: "Game Master offline · try again when this turns green", reload: false };
  }
  return answers
    ? { tone: "backup", text: "Backup Game Master · the main one is back, tap to reload", reload: true }
    : { tone: "backup", text: "Backup Game Master · the main one is offline", reload: false };
}

export type StatusBadge = {
  /** Ask the relay now (a call to it just failed). */
  recheck: () => void;
  /** The page settled on a Game Master. */
  setUsing: (using: PageGameMaster) => void;
};

export function mountStatusBadge(opts: {
  relay: string;
  fetch: typeof fetch;
  using: PageGameMaster;
  intervalMs?: number;
}): StatusBadge {
  let using = opts.using;
  let status: RelayStatus | null | undefined;
  let checking: Promise<void> | undefined;

  const button = document.createElement("button");
  button.id = "nq-gm-status";
  button.type = "button";
  button.setAttribute("role", "status");
  button.setAttribute("aria-live", "polite");
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  Object.assign(button.style, {
    position: "fixed",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    border: "2px solid #888",
    borderRadius: "999px",
    background: "rgba(22, 22, 26, 0.88)",
    color: "#fff",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.35)",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  const dot = document.createElement("span");
  Object.assign(dot.style, { borderRadius: "50%", flex: "none" });
  const label = document.createElement("span");
  button.append(dot, label);
  document.body.append(button);

  const render = () => {
    if (status === undefined) {
      dot.style.background = "#888";
      button.style.borderColor = "#888";
      label.textContent = "Checking the Game Master…";
      button.dataset.state = "checking";
      button.title = "";
      return;
    }
    const view = badgeView(status, using);
    dot.style.background = COLORS[view.tone];
    button.style.borderColor = COLORS[view.tone];
    label.textContent = view.text;
    button.dataset.state = view.tone;
    button.title = view.reload ? "Reload the page" : "Check again";
  };

  const recheck = () => {
    checking ??= (async () => {
      try {
        const res = await opts.fetch(`${opts.relay}/status`, { cache: "no-store" });
        status = res.ok ? ((await res.json()) as RelayStatus) : null;
      } catch {
        status = null;
      }
      render();
    })().finally(() => {
      checking = undefined;
    });
  };

  button.addEventListener("click", () => {
    if (status !== undefined && badgeView(status, using).reload) location.reload();
    else recheck();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") recheck();
  });
  setInterval(recheck, opts.intervalMs ?? RECHECK_MS);
  render();
  recheck();
  return {
    recheck,
    setUsing: (next) => {
      using = next;
      render();
    },
  };
}
