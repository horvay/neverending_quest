import { Context, Data, Effect, Layer, PubSub, Stream } from "effect";
import { CampaignError } from "../campaign/errors.ts";
import type { InspectSaveResult } from "../campaign/inspect.ts";
import type { PlayState, ScratchRecord, TranscriptRow } from "../campaign/types.ts";
import { PlayLoop } from "./loop.ts";
import {
  applyPlayEvent,
  createKernel,
  type KernelState,
  type StoryBlock,
} from "./kernel.ts";
import type {
  AgentSessionFactory,
  Illustrator,
  InspectLeaf,
  ManualHygieneMode,
  PlayConfig,
  PlayEvent,
} from "./types.ts";

export class PlayOpenError extends Data.TaggedError("PlayOpenError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type PlaySessionApi = {
  readonly campaignPath: string;
  readonly submit: (text: string) => Effect.Effect<void>;
  readonly interrupt: () => Effect.Effect<void>;
  readonly endReasoning: () => Effect.Effect<boolean, CampaignError>;
  readonly editTranscript: (
    ts: string,
    text: string,
  ) => Effect.Effect<TranscriptRow, CampaignError>;
  readonly deleteTranscript: (
    ts?: string,
  ) => Effect.Effect<TranscriptRow[], CampaignError>;
  readonly retryTranscript: (
    ts: string,
    thinking?: string,
  ) => Effect.Effect<void, CampaignError>;
  readonly continueFromTurn: (
    turn: number,
  ) => Effect.Effect<void, CampaignError>;
  readonly setLuckArmed: (
    armed: boolean,
  ) => Effect.Effect<PlayState, CampaignError>;
  readonly saveInspect: (
    target: string,
    body: string,
    hash: string,
    slug?: string,
  ) => Effect.Effect<InspectSaveResult, CampaignError>;
  readonly createDossier: (
    slug: string,
    body?: string,
  ) => Effect.Effect<InspectSaveResult, CampaignError>;
  readonly archiveDossier: (
    slug: string,
    archive?: boolean,
  ) => Effect.Effect<
    { slug: string; archived: boolean; moved: boolean },
    CampaignError
  >;
  readonly startHygiene: (
    mode: ManualHygieneMode,
  ) => Effect.Effect<void, CampaignError>;
  readonly illustrationStatus: () => Effect.Effect<
    { ready: boolean; reason?: string },
    CampaignError
  >;
  readonly illustrate: (opts?: {
    prompt?: string;
  }) => Effect.Effect<{ ts: string; prompt: string }, CampaignError>;
  readonly pickIllustration: (
    slot: number,
  ) => Effect.Effect<{ ts: string; prompt: string }, CampaignError>;
  readonly cancelIllustration: () => Effect.Effect<void, CampaignError>;
  readonly history: () => Effect.Effect<
    Array<{ turn: number; prose: string }>,
    CampaignError
  >;
  readonly scratch: () => Effect.Effect<ScratchRecord[], CampaignError>;
  readonly inspect: (
    target: string,
    slug?: string,
  ) => Effect.Effect<InspectLeaf, CampaignError>;
  /** The kept picture of a Turn, or a candidate sitting, as a file path. */
  readonly illustrationFile: (
    ts: string,
    slot?: number,
  ) => Effect.Effect<string, CampaignError>;
  readonly events: Stream.Stream<PlayEvent>;
  readonly snapshot: Effect.Effect<KernelState>;
  readonly isBusy: Effect.Effect<boolean>;
  readonly isOpen: Effect.Effect<boolean>;
};

export class PlaySession extends Context.Tag("nq/PlaySession")<
  PlaySession,
  PlaySessionApi
>() {}

export type PlaySessionOptions = {
  path?: string;
  factory: AgentSessionFactory;
  config?: Partial<PlayConfig>;
  endReasoning?: () => Promise<boolean>;
  illustrator?: Illustrator;
};

/** The player commands of a PlaySessionApi: everything but its state reads. */
type PlayCommands = Omit<
  PlaySessionApi,
  "campaignPath" | "events" | "snapshot" | "isBusy" | "isOpen"
>;
type CommandName = keyof PlayCommands;

export function playSessionLayer(
  opts: PlaySessionOptions,
): Layer.Layer<PlaySession, PlayOpenError> {
  return Layer.scoped(
    PlaySession,
    Effect.acquireRelease(openPlayHandle(opts), (handle) =>
      Effect.promise(() => closePlayHandle(handle)),
    ).pipe(Effect.map((handle) => handle.api)),
  );
}

export function withPlaySession<A, E, R>(
  body:
    | Effect.Effect<A, E, R>
    | ((api: PlaySessionApi) => Effect.Effect<A, E, R>),
): Effect.Effect<A, E | PlayOpenError, R | PlaySession> {
  return Effect.gen(function* () {
    const api = yield* PlaySession;
    return yield* typeof body === "function" ? body(api) : body;
  });
}

export type PlayHandle = {
  loop: PlayLoop;
  pubsub: PubSub.PubSub<PlayEvent>;
  api: PlaySessionApi;
};

export function openPlayHandle(
  opts: PlaySessionOptions,
): Effect.Effect<PlayHandle, PlayOpenError> {
  return Effect.gen(function* () {
    const pubsub = yield* PubSub.sliding<PlayEvent>(256);
    let kernel = createKernel();
    const loop = new PlayLoop({
      path: opts.path,
      factory: opts.factory,
      config: opts.config,
      illustrator: opts.illustrator,
      onEvent: (event) => {
        kernel = applyPlayEvent(kernel, event);
        pubsub.unsafeOffer(event);
      },
    });
    yield* Effect.tryPromise({
      try: () => loop.open(),
      catch: (err) =>
        new PlayOpenError({
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        }),
    });
    const reloadKernel = async () => {
      const story: StoryBlock[] = await loop.snapshotStory();
      await loop.refreshContext();
      kernel = createKernel({
        story,
        successTurnCount: loop.currentPlayState.success_turn_count,
        context: loop.contextUsage,
        busy: loop.loopState !== "idle",
      });
    };
    yield* Effect.promise(() => reloadKernel());

    /**
     * One loop call as a command; its errors become CampaignErrors naming
     * `label`. `reloadsKernel` rebuilds the kernel from disk after a call
     * that rewrote the story.
     */
    const command =
      <A extends unknown[], R>(
        label: string,
        run: (...args: A) => Promise<R>,
        { reloadsKernel = false } = {},
      ) =>
      (...args: A): Effect.Effect<R, CampaignError> =>
        Effect.tryPromise({
          try: async () => {
            const result = await run(...args);
            if (reloadsKernel) await reloadKernel();
            return result;
          },
          catch: (err) => asCampaignError(err, label),
        });
    const reloads = { reloadsKernel: true };

    const commands: PlayCommands = {
      submit: (text) =>
        Effect.sync(() => {
          void loop.turn(text);
        }),
      interrupt: () => Effect.sync(() => loop.interrupt()),
      endReasoning: command(
        "end local reasoning",
        () => opts.endReasoning?.() ?? Promise.resolve(false),
      ),
      editTranscript: command(
        "edit",
        (ts, text) => loop.editTranscript(ts, text),
        reloads,
      ),
      deleteTranscript: command(
        "delete",
        (ts) => loop.deleteTranscript(ts),
        reloads,
      ),
      retryTranscript: command("retry", (ts, thinking) =>
        loop.startRetryTranscript(ts, thinking),
      ),
      continueFromTurn: command("continue", (turn) => loop.startContinue(turn)),
      setLuckArmed: command("set Luck Points", (armed) =>
        loop.setLuckArmed(armed),
      ),
      saveInspect: command(
        "inspect",
        (target, body, hash, slug) => loop.saveInspect(target, body, hash, slug),
        reloads,
      ),
      createDossier: command(
        "dossier",
        (slug, body) => loop.createDossier(slug, body),
        reloads,
      ),
      archiveDossier: command(
        "archive",
        (slug, archive) => loop.archiveDossier(slug, archive),
        reloads,
      ),
      startHygiene: command("hygiene", (mode) => loop.startHygiene(mode)),
      illustrationStatus: command("illustrate", () => loop.illustrationStatus()),
      illustrate: command("illustrate", (opts) => loop.illustrate(opts), reloads),
      pickIllustration: command(
        "illustrate",
        (slot) => loop.pickIllustration(slot),
        reloads,
      ),
      cancelIllustration: command("illustrate", () => loop.cancelIllustration()),
      history: command("history", () => loop.history()),
      scratch: command("scratch", () => loop.listScratch()),
      inspect: command("inspect", (target, slug) => loop.inspect(target, slug)),
      illustrationFile: command("illustrate", async (ts, slot) =>
        loop.illustrationFile(ts, slot),
      ),
    };
    const api: PlaySessionApi = {
      campaignPath: loop.campaignPath,
      ...commands,
      events: Stream.fromPubSub(pubsub),
      snapshot: Effect.sync(() => ({
        ...kernel,
        story: [...kernel.story],
      })),
      isBusy: Effect.sync(() => loop.loopState !== "idle"),
      isOpen: Effect.succeed(true),
    };
    return { loop, pubsub, api };
  });
}

export async function closePlayHandle(handle: PlayHandle): Promise<void> {
  await handle.loop.close();
  await Effect.runPromise(PubSub.shutdown(handle.pubsub));
}

const noCampaign = () => Effect.fail(new CampaignError("busy", "No campaign open"));

/** What each command answers while no Campaign is open behind a facade. */
const WHILE_CLOSED: {
  readonly [K in CommandName]: () => ReturnType<PlayCommands[K]>;
} = {
  submit: () => Effect.void,
  interrupt: () => Effect.void,
  endReasoning: () => Effect.succeed(false),
  editTranscript: noCampaign,
  deleteTranscript: noCampaign,
  retryTranscript: noCampaign,
  continueFromTurn: noCampaign,
  setLuckArmed: noCampaign,
  saveInspect: noCampaign,
  createDossier: noCampaign,
  archiveDossier: noCampaign,
  startHygiene: noCampaign,
  illustrationStatus: () =>
    Effect.succeed({ ready: false as const, reason: "No campaign open" }),
  illustrate: noCampaign,
  pickIllustration: noCampaign,
  cancelIllustration: () => Effect.succeed(undefined),
  history: noCampaign,
  scratch: noCampaign,
  inspect: noCampaign,
  illustrationFile: noCampaign,
};

/**
 * A PlaySessionApi over whichever Campaign is open right now (Home opens and
 * closes them), forwarding every command to it and answering WHILE_CLOSED
 * when none is.
 */
export function playSessionFacade(
  current: () => PlayHandle | null,
): PlaySessionApi {
  const forward = (name: CommandName) =>
    (...args: unknown[]) => {
      const handle = current();
      if (!handle) return WHILE_CLOSED[name]();
      const run = handle.api[name] as (...args: unknown[]) => unknown;
      return run(...args);
    };
  const commands = Object.fromEntries(
    (Object.keys(WHILE_CLOSED) as CommandName[]).map((name) => [
      name,
      forward(name),
    ]),
  ) as PlayCommands;
  return {
    get campaignPath() {
      return current()?.api.campaignPath ?? "";
    },
    ...commands,
    events: Stream.unwrap(
      Effect.sync(() => current()?.api.events ?? Stream.empty),
    ),
    snapshot: Effect.suspend(() =>
      current()?.api.snapshot ?? Effect.succeed(createKernel()),
    ),
    isBusy: Effect.suspend(() =>
      current()?.api.isBusy ?? Effect.succeed(false),
    ),
    isOpen: Effect.sync(() => current() !== null),
  };
}

function asCampaignError(err: unknown, action: string): CampaignError {
  if (err instanceof CampaignError) return err;
  return new CampaignError(
    "session_failed",
    err instanceof Error ? err.message : `Failed to ${action}`,
  );
}
