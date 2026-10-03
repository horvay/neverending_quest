import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { Cause, Deferred, Effect, Exit, Layer, Stream } from "effect";
import { readLocalLogChunk } from "@nq/local-inference/logs.ts";
import type { HomeSurface } from "../../home/index.ts";
import { LIVE_SETTING_KEYS } from "../../home/surface.ts";
import { applyPlayEvent } from "../../play/kernel.ts";
import { runHomeTui } from "./home.ts";
import {
  playSessionFacade,
  PlaySession,
  withPlaySession,
} from "../../play/session.ts";
import { mountPlayChrome } from "./chrome.ts";

/** Show a picture in the player's own image viewer. */
export type OpenImage = (path: string) => Promise<void>;

const xdgOpen: OpenImage = async (file) => {
  // the viewer must not touch the terminal the play screen owns
  const proc = Bun.spawn(["xdg-open", file], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await proc.exited) !== 0) throw new Error("xdg-open failed");
};

/** One session command; a refusal rejects with the error itself, not a FiberFailure. */
async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** `nq play`: Home, then a Campaign in the terminal, until the player quits. */
export async function runPlay(
  surface: HomeSurface,
  opts: {
    path?: string;
    /** The terminal is external: tests pass OpenTUI's test renderer here. */
    renderer?: CliRenderer;
    /** The image viewer is external too (default `xdg-open`). */
    openImage?: OpenImage;
  } = {},
): Promise<number> {
  let renderer: CliRenderer;
  try {
    renderer = opts.renderer ?? (await createCliRenderer({ exitOnCtrlC: false }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(
      "OpenTUI native renderer failed to load. Use nq turn or nq serve.",
    );
    return 1;
  }

  try {
    return await runPlayWithHome(renderer, surface, opts.path, opts.openImage ?? xdgOpen);
  } catch (err) {
    try {
      renderer.destroy();
    } catch {
      // ignore
    }
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function runPlayWithHome(
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
  surface: HomeSurface,
  path: string | undefined,
  openImage: OpenImage,
): Promise<number> {
  if (path) {
    await surface.openPath(path);
    const left = await runPlayChromeFromSurface(renderer, surface, openImage);
    if (left !== 0) {
      renderer.destroy();
      return left;
    }
    await surface.leave();
  }

  for (;;) {
    if (!surface.play) {
      const home = await runHomeTui(renderer, surface);
      if (home === "quit") {
        renderer.destroy();
        return 0;
      }
    }
    const code = await runPlayChromeFromSurface(renderer, surface, openImage);
    if (code !== 0) {
      renderer.destroy();
      return code;
    }
    await surface.leave();
  }
}

async function runPlayChromeFromSurface(
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
  surface: HomeSurface,
  openImage: OpenImage,
): Promise<number> {
  const handle = surface.play;
  if (!handle) return 0;
  const layer = Layer.succeed(PlaySession, playSessionFacade(() => surface.play));
  return runMountedChrome(renderer, layer, surface, openImage);
}

function runMountedChrome(
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
  layer: Layer.Layer<PlaySession, unknown>,
  surface: HomeSurface,
  openImage: OpenImage,
): Promise<number> {
  const program = withPlaySession((session) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<number>();
      let state = yield* session.snapshot;
      const chrome = mountPlayChrome(renderer, {
        submit: (text) => {
          void Effect.runPromise(session.submit(text));
        },
        quit: () => {
          void Effect.runPromise(Deferred.succeed(done, 0));
        },
        interrupt: () => {
          void Effect.runPromise(session.interrupt());
        },
        editTranscript: (ts, text) => run(session.editTranscript(ts, text)),
        deleteTranscript: (ts) => run(session.deleteTranscript(ts)),
        retryTranscript: (ts, thinking) => run(session.retryTranscript(ts, thinking)),
        continueFromTurn: (turn) => run(session.continueFromTurn(turn)),
        endReasoning: () => run(session.endReasoning()),
        setLuckArmed: (armed) => run(session.setLuckArmed(armed)),
        startHygiene: (mode) => run(session.startHygiene(mode)),
        history: () => run(session.history()),
        scratch: () => run(session.scratch()),
        inspect: (target, slug) => run(session.inspect(target, slug)),
        saveInspect: (target, body, hash, slug) =>
          run(session.saveInspect(target, body, hash, slug)),
        createDossier: (slug) => run(session.createDossier(slug)),
        archiveDossier: (slug, archive) => run(session.archiveDossier(slug, archive)),
        illustrationStatus: () => run(session.illustrationStatus()),
        illustrate: (prompt) =>
          run(session.illustrate(prompt !== undefined ? { prompt } : undefined)),
        pickIllustration: (slot) => run(session.pickIllustration(slot)),
        cancelIllustration: () => run(session.cancelIllustration()),
        illustrationFile: (ts, slot) => run(session.illustrationFile(ts, slot)),
        openImage,
        playHome: async () => {
          const snap = await surface.snapshot();
          const settings: Record<string, unknown> = {};
          for (const key of LIVE_SETTING_KEYS) settings[key] = snap.settings[key];
          return {
            settings,
            fixed: snap.fixedSettings,
            diagnostics: snap.diagnostics,
            model: snap.settings.model,
          };
        },
        savePlaySettings: (value) => surface.updatePlaySettings(value),
        readLocalLog: (source) => readLocalLogChunk({ source }),
      });
      chrome.paint(state);
      yield* session.events.pipe(
        Stream.runForEach((ev) =>
          Effect.sync(() => {
            state = applyPlayEvent(state, ev);
            chrome.event(ev, state);
          }),
        ),
        Effect.fork,
      );
      const onInt = () => {
        if (state.busy) {
          void Effect.runPromise(session.interrupt());
          return;
        }
        void Effect.runPromise(Deferred.succeed(done, 0));
      };
      process.on("SIGINT", onInt);
      const code = yield* Deferred.await(done);
      process.off("SIGINT", onInt);
      chrome.unmount();
      try {
        const kids = renderer.root.getChildren();
        for (const child of kids) renderer.root.remove(child);
      } catch {
        // ignore
      }
      return code;
    }),
  ).pipe(Effect.provide(layer), Effect.scoped);

  return Effect.runPromise(program);
}
