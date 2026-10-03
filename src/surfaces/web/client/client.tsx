import { render } from "preact";
import { useRef } from "preact/hooks";
import { isLlamaCppModel } from "../../../model_selector.ts";
import { BookApp } from "./book.tsx";
import { HomeApp } from "./home.tsx";
import { DiceOverlay } from "./dice_overlay.tsx";
import { applyReadingPrefs, readReadingPrefs } from "./reading_prefs.ts";
import { api } from "./api_client.ts";
import { useHome } from "./use_home.ts";
import { usePlay } from "./use_play.ts";
import { useIllustration } from "./use_illustration.ts";
import { useDiceCasts } from "./use_dice_casts.ts";

export function Root() {
  const home = useHome();
  const dice = useDiceCasts();
  const play = usePlay({
    playing: home.playing,
    home: home.home,
    onEvent: (ev) => {
      illustration.onEvent(ev);
      if (ev.type === "roll") dice.show(ev.n, ev.value, ev.reason);
    },
  });
  const illustration = useIllustration({
    playing: home.playing,
    setAuthoring: play.setAuthoring,
    setNotice: play.setNotice,
  });
  const prefsApplied = useRef(false);
  if (!prefsApplied.current) {
    prefsApplied.current = true;
    applyReadingPrefs(readReadingPrefs());
  }

  const view = home.home;
  // still loading, or on the way into the adventure the address names
  // (unless a local model is loading for it: Home shows that dialog)
  if (
    view === undefined ||
    (home.routing && view && !view.open && view.login.phase !== "working")
  ) {
    return (
      <div class="home-boot" role="status" aria-label="Opening the book">
        <h1>Neverending Quest</h1>
      </div>
    );
  }

  if (view && !view.open) {
    return <HomeApp snap={view} {...home.actions} />;
  }

  const model = view?.settings.model.trim();
  return (
    <>
      <DiceOverlay cast={dice.cast} onDone={dice.done} />
      <BookApp
        state={play.state}
        inspect={play.inspect}
        campaignName={play.campaignName}
        authoring={play.authoring}
        scratch={play.scratch}
        history={play.history}
        notice={play.notice}
        {...play.commands}
        {...illustration.props}
        canEndReasoning={Boolean(model?.startsWith("llama.cpp/"))}
        canEditScratch={isLlamaCppModel(model)}
        onComposeInput={warmModel}
        playSettings={view?.settings}
        fixedSettings={view?.fixedSettings}
        onSavePlaySettings={async (settings) => {
          const reply = await api.playSettings(settings);
          if (reply.ok) {
            home.setHome(reply.body);
            return null;
          }
          if (reply.status === 0) return "Could not reach the book's server.";
          return reply.error ?? "Could not save settings.";
        }}
        onLeave={() => {
          play.setNotice("");
          void home.leave();
        }}
      />
    </>
  );
}

let lastWarmAt = 0;

/** Keystrokes wake a scale-to-zero Game Master; the server ignores the rest. */
function warmModel(): void {
  const now = Date.now();
  if (now - lastWarmAt < 15_000) return;
  lastWarmAt = now;
  void api.warmModel();
}

/**
 * Keep `--app-height` equal to the *visible* viewport. Mobile Safari does not
 * resize the layout viewport for the on-screen keyboard (and 100vh includes
 * the collapsed address bar), so a 100vh book leaves the composer hidden
 * under the keyboard or the toolbar. While the page is one fixed-height book
 * (the body does not scroll), we also pin the window scroll to the top of the
 * visual viewport so the book lines up with what is shown. A page that scrolls
 * (Home on a phone) is left alone: its address bar collapsing as the player
 * scrolls down resizes the viewport too, and pinning then threw them back up.
 */
function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    document.documentElement.style.setProperty(
      "--app-height",
      `${Math.round(vv.height)}px`,
    );
    const fixed = getComputedStyle(document.body).overflowY === "hidden";
    if (fixed && (window.scrollY !== 0 || vv.offsetTop !== 0)) {
      window.scrollTo(0, 0);
    }
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  window.addEventListener("orientationchange", apply);
  apply();
}
trackVisualViewport();

const root = document.getElementById("root");
if (root) render(<Root />, root);
