import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Stream } from "effect";
import { isCampaignError } from "../../campaign/errors.ts";
import { PlaySession, type PlaySessionApi } from "../../play/session.ts";
import { INSPECT_TARGETS } from "../../play/types.ts";
import type { KernelState } from "../../play/kernel.ts";
import { readFile } from "node:fs/promises";
import { isEnoent } from "../../campaign/fs_util.ts";
import {
  isLocalLogSource,
  readLocalLogChunk,
} from "@nq/local-inference/logs.ts";
import type {
  ContinueRequest,
  DossierArchived,
  DossierArchiveRequest,
  DossierCreated,
  DossierCreateRequest,
  HistoryResponse,
  HygieneRequest,
  IllustrateRequest,
  IllustrationPickRequest,
  IllustrationStarted,
  InspectLeaf,
  LuckRequest,
  LuckResponse,
  RetryRequest,
  ScratchResponse,
  TranscriptDeleteRequest,
  TranscriptEditRequest,
  TurnRequest,
} from "./api.ts";
import {
  accepted,
  BAD,
  badRequest,
  conflict,
  int,
  jsonBody,
  noContent,
  optionalJsonBody,
  optStr,
  requireOrigin,
  str,
  type Body,
  type Parsed,
} from "./route_kit.ts";


const encoder = new TextEncoder();

function jsonLine(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

type Guard = "idle" | "open" | "none";

/**
 * A state-changing play route: same-origin, then the Campaign must be open
 * (and Idle, for `idle`), then the body parses or it is a 400, then the
 * session runs it and a CampaignError maps to its status.
 */
function playCommand<A>(opts: {
  guard: Guard;
  body?: "json" | "optional";
  parse: (body: Body) => Parsed<A>;
  run: (
    session: PlaySessionApi,
    args: A,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
}) {
  return Effect.gen(function* () {
    const denied = yield* requireOrigin;
    if (denied) return denied;
    const session = yield* PlaySession;
    if (opts.guard !== "none" && !(yield* session.isOpen)) return yield* conflict;
    if (opts.guard === "idle" && (yield* session.isBusy)) return yield* conflict;
    const body: Body =
      opts.body === "json"
        ? yield* jsonBody
        : opts.body === "optional"
          ? yield* optionalJsonBody
          : {};
    const args = opts.parse(body);
    if (args === BAD) return yield* badRequest;
    return yield* opts
      .run(session, args)
      .pipe(Effect.catchAll((err) => authoringFail(err)));
  });
}

const none = (): undefined => undefined;

const postTurn = playCommand<TurnRequest>({
  guard: "idle",
  body: "json",
  // an empty Turn is `(continue)`; the loop decides
  parse: (b) => ({ text: "text" in b ? String(b.text) : "" }),
  run: (session, { text }) => session.submit(text).pipe(Effect.as(accepted)),
});

const postLuck = playCommand<LuckRequest>({
  guard: "idle",
  body: "json",
  parse: (b) => (typeof b.armed === "boolean" ? { armed: b.armed } : BAD),
  run: (session, { armed }) =>
    session.setLuckArmed(armed).pipe(
      Effect.flatMap((state: LuckResponse) => HttpServerResponse.json(state)),
    ),
});

const postInterrupt = playCommand({
  guard: "none",
  parse: none,
  run: (session) => session.interrupt().pipe(Effect.as(noContent)),
});

const postEndReasoning = playCommand({
  guard: "open",
  parse: none,
  run: (session) =>
    session
      .endReasoning()
      .pipe(Effect.map((success) => (success ? noContent : conflict))),
});

const postTranscriptEdit = playCommand<TranscriptEditRequest>({
  guard: "idle",
  body: "json",
  parse: (b) => {
    const ts = str(b, "ts");
    const text = str(b, "text");
    return ts !== undefined && text !== undefined ? { ts, text } : BAD;
  },
  run: (session, { ts, text }) =>
    session.editTranscript(ts, text).pipe(Effect.as(noContent)),
});

const postTranscriptDelete = playCommand<TranscriptDeleteRequest>({
  guard: "idle",
  body: "optional",
  parse: (b) => {
    const ts = optStr(b, "ts");
    return ts === BAD ? BAD : { ts };
  },
  run: (session, { ts }) => session.deleteTranscript(ts).pipe(Effect.as(noContent)),
});

/**
 * 202 = accepted. The latest completed Turn is rewound and submitted again;
 * with `thinking`, the Game Master's reasoning continues from that text.
 */
const postRetry = playCommand<RetryRequest>({
  guard: "idle",
  body: "json",
  parse: (b) => {
    const ts = str(b, "ts");
    const thinking = optStr(b, "thinking");
    if (ts === undefined || thinking === BAD) return BAD;
    return thinking === undefined ? { ts } : { ts, thinking };
  },
  run: (session, { ts, thinking }) =>
    session.retryTranscript(ts, thinking).pipe(Effect.as(accepted)),
});

/** 202 = accepted (like /api/turn). Outcome is on /api/events, not this POST. */
const postContinue = playCommand<ContinueRequest>({
  guard: "idle",
  body: "json",
  parse: (b) => {
    const turn = int(b, "turn");
    return turn !== undefined && turn >= 0 ? { turn } : BAD;
  },
  run: (session, { turn }) => session.continueFromTurn(turn).pipe(Effect.as(accepted)),
});

const HYGIENE_MODES: ReadonlySet<unknown> = new Set(["light", "heavy", "compact", "fresh"]);

/** 202 = accepted (like /api/turn). Outcome is on /api/events, not this POST. */
const postHygiene = playCommand<HygieneRequest>({
  guard: "idle",
  body: "json",
  parse: (b) =>
    HYGIENE_MODES.has(b.mode) ? { mode: b.mode as HygieneRequest["mode"] } : BAD,
  run: (session, { mode }) => session.startHygiene(mode).pipe(Effect.as(accepted)),
});

const postInspectDossier = playCommand<DossierCreateRequest>({
  guard: "idle",
  body: "json",
  parse: (b) => {
    const slug = str(b, "slug");
    const body = optStr(b, "body");
    if (slug === undefined || body === BAD) return BAD;
    return body === undefined ? { slug } : { slug, body };
  },
  run: (session, { slug, body }) =>
    session.createDossier(slug, body).pipe(
      Effect.flatMap((created: DossierCreated) =>
        HttpServerResponse.json(created, { status: 201 }),
      ),
    ),
});

const postArchiveDossier = (slug: string | undefined) =>
  playCommand<DossierArchiveRequest>({
    guard: "idle",
    body: "optional",
    parse: (b) => (slug ? { archive: typeof b.archive === "boolean" ? b.archive : true } : BAD),
    run: (session, { archive }) =>
      session.archiveDossier(slug!, archive).pipe(
        Effect.flatMap((result: DossierArchived) => HttpServerResponse.json(result)),
      ),
  });

const postIllustration = playCommand<IllustrateRequest>({
  guard: "idle",
  body: "optional",
  parse: (b) => {
    const prompt = optStr(b, "prompt");
    if (prompt === BAD) return BAD;
    return prompt === undefined ? {} : { prompt };
  },
  run: (session, args) =>
    session
      .illustrate(args.prompt !== undefined ? args : undefined)
      .pipe(Effect.flatMap((started: IllustrationStarted) => HttpServerResponse.json(started))),
});

const postIllustrationPick = playCommand<IllustrationPickRequest>({
  guard: "open",
  body: "optional",
  parse: (b) => {
    const slot = int(b, "slot");
    return slot === undefined ? BAD : { slot };
  },
  run: (session, { slot }) =>
    session
      .pickIllustration(slot)
      .pipe(Effect.flatMap((kept: IllustrationStarted) => HttpServerResponse.json(kept))),
});

const postIllustrationCancel = playCommand({
  guard: "open",
  parse: none,
  run: (session) => session.cancelIllustration().pipe(Effect.as(noContent)),
});

const getLocalLog = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(req.url, "http://127.0.0.1");
  const source = url.searchParams.get("source") ?? "engine";
  if (!isLocalLogSource(source)) {
    return yield* HttpServerResponse.empty({ status: 400 });
  }
  const rawOffset = url.searchParams.get("offset");
  const offset = rawOffset === null ? undefined : Number(rawOffset);
  if (
    offset !== undefined &&
    (!Number.isSafeInteger(offset) || offset < 0)
  ) {
    return yield* HttpServerResponse.empty({ status: 400 });
  }
  const file = url.searchParams.get("file") ?? undefined;
  const chunk = yield* Effect.tryPromise({
    try: () => readLocalLogChunk({ source, offset, ...(file ? { file } : {}) }),
    catch: (error) => error,
  });
  return yield* HttpServerResponse.json(chunk, {
    headers: { "cache-control": "no-store" },
  });
}).pipe(
  Effect.catchAll(() => HttpServerResponse.empty({ status: 500 })),
);

function authoringFail(err: unknown) {
  if (isCampaignError(err)) {
    if (err.code === "stale") {
      return HttpServerResponse.json(
        { text: err.diskText ?? "", hash: err.diskHash ?? "" },
        { status: 409 },
      );
    }
    if (
      err.code === "busy" ||
      err.code === "not_last" ||
      err.code === "dossier_exists"
    ) {
      return HttpServerResponse.empty({ status: 409 });
    }
    if (err.code === "dossier_slug_invalid") {
      return HttpServerResponse.empty({ status: 400 });
    }
    if (err.code === "unavailable") {
      return HttpServerResponse.json(
        { error: err.message },
        { status: 503 },
      );
    }
    if (err.code === "bad_prompt") {
      return HttpServerResponse.json(
        { error: err.message },
        { status: 422 },
      );
    }
    if (
      err.code === "not_found" ||
      err.code === "inspect_forbidden" ||
      err.code === "dossier_missing"
    ) {
      return HttpServerResponse.empty({ status: 404 });
    }
    if (err.code === "generate_failed") {
      return HttpServerResponse.json(
        { error: err.message },
        { status: 500 },
      );
    }
  }
  return HttpServerResponse.empty({ status: 500 });
}






function ifMatchHash(req: HttpServerRequest.HttpServerRequest): string | undefined {
  const raw = req.headers["if-match"];
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  return raw.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

const putInspect = (target: string, slug?: string) =>
  Effect.gen(function* () {
    const denied = yield* requireOrigin;
    if (denied) return denied;
    const session = yield* PlaySession;
    if (!(yield* session.isOpen) || (yield* session.isBusy)) {
      return yield* conflict;
    }
    if (!INSPECT_TARGETS.has(target) || target === "status") {
      return yield* HttpServerResponse.empty({ status: 404 });
    }
    if (target === "dossiers" && !slug) {
      return yield* HttpServerResponse.empty({ status: 404 });
    }
    const req = yield* HttpServerRequest.HttpServerRequest;
    const hash = ifMatchHash(req);
    if (!hash) {
      return yield* HttpServerResponse.empty({ status: 400 });
    }
    const body = yield* req.text;
    return yield* session.saveInspect(target, body, hash, slug).pipe(
      Effect.flatMap(() => HttpServerResponse.empty({ status: 204 })),
      Effect.catchAll((err) => authoringFail(err)),
    );
  });


const getEvents = Effect.gen(function* () {
  const session = yield* PlaySession;
  if (!(yield* session.isOpen)) {
    return yield* HttpServerResponse.empty({ status: 409 });
  }
  const snap: KernelState = yield* session.snapshot;
  const bytes = Stream.concat(
    Stream.make(jsonLine(snap)),
    session.events.pipe(Stream.map((ev) => jsonLine(ev))),
  );
  return yield* HttpServerResponse.stream(bytes, {
    contentType: "application/x-ndjson",
  });
});

const getHistory = Effect.gen(function* () {
  const session = yield* PlaySession;
  if (!(yield* session.isOpen)) return yield* conflict;
  return yield* session.history().pipe(
    Effect.flatMap((entries) =>
      HttpServerResponse.json({ entries } satisfies HistoryResponse),
    ),
    Effect.catchAll(() => HttpServerResponse.empty({ status: 500 })),
  );
});

const getScratch = Effect.gen(function* () {
  const session = yield* PlaySession;
  if (!(yield* session.isOpen)) return yield* conflict;
  return yield* session.scratch().pipe(
    Effect.flatMap((records) =>
      HttpServerResponse.json({ records } satisfies ScratchResponse),
    ),
    Effect.catchAll(() => HttpServerResponse.empty({ status: 500 })),
  );
});

const getIllustrationStatus = Effect.gen(function* () {
  const session = yield* PlaySession;
  if (!(yield* session.isOpen)) {
    return yield* HttpServerResponse.empty({ status: 409 });
  }
  const status = yield* session.illustrationStatus();
  return yield* HttpServerResponse.json(status);
});

const getIllustrationPng = Effect.gen(function* () {
  const session = yield* PlaySession;
  if (!(yield* session.isOpen)) return yield* conflict;
  const params = yield* HttpRouter.params;
  const req = yield* HttpServerRequest.HttpServerRequest;
  let ts: string;
  let slot: number | undefined;
  try {
    ts = decodeURIComponent(params.ts ?? "");
    const rawSlot = new URL(req.url, "http://127.0.0.1").searchParams.get("slot");
    slot = rawSlot === null ? undefined : Number(rawSlot);
  } catch {
    return yield* HttpServerResponse.empty({ status: 404 });
  }
  const file = yield* session
    .illustrationFile(ts, slot)
    .pipe(Effect.orElseSucceed(() => null));
  if (!file) return yield* HttpServerResponse.empty({ status: 404 });
  const loaded = yield* Effect.tryPromise({
    try: async () => ({ ok: true as const, bytes: await readFile(file) }),
    catch: (err) => err,
  }).pipe(
    Effect.catchAll((err) =>
      Effect.succeed({ ok: false as const, missing: isEnoent(err) }),
    ),
  );
  if (!loaded.ok) {
    return yield* HttpServerResponse.empty({ status: loaded.missing ? 404 : 500 });
  }
  return yield* HttpServerResponse.uint8Array(loaded.bytes, {
    contentType: "image/png",
  });
});

function inspectEffect(target: string, slug?: string) {
  return Effect.gen(function* () {
    if (!INSPECT_TARGETS.has(target)) return yield* HttpServerResponse.empty({ status: 404 });
    const session = yield* PlaySession;
    if (!(yield* session.isOpen)) return yield* conflict;
    return yield* session.inspect(target, slug).pipe(
      Effect.flatMap((leaf: InspectLeaf) => HttpServerResponse.json(leaf)),
      Effect.catchAll(() => HttpServerResponse.empty({ status: 404 })),
    );
  });
}

export const serveHttpApp = HttpRouter.empty.pipe(
  HttpRouter.get("/api/events", getEvents),
  HttpRouter.get("/api/history", getHistory),
  HttpRouter.get("/api/scratch", getScratch),
  HttpRouter.get("/api/local/log", getLocalLog),
  HttpRouter.post("/api/turn", postTurn),
  HttpRouter.post("/api/luck", postLuck),
  HttpRouter.post("/api/interrupt", postInterrupt),
  HttpRouter.post("/api/reasoning/end", postEndReasoning),
  HttpRouter.post("/api/transcript/edit", postTranscriptEdit),
  HttpRouter.post("/api/transcript/delete", postTranscriptDelete),
  HttpRouter.post("/api/retry", postRetry),
  HttpRouter.post("/api/continue", postContinue),
  HttpRouter.post("/api/hygiene", postHygiene),
  HttpRouter.post(
    "/api/inspect/dossiers/:slug/archive",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* postArchiveDossier(params.slug);
    }),
  ),
  HttpRouter.put("/api/inspect/dossiers/:slug", Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    return yield* putInspect("dossiers", params.slug);
  })),
  HttpRouter.post("/api/inspect/dossiers", postInspectDossier),
  HttpRouter.put("/api/inspect/:target", Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    return yield* putInspect(params.target ?? "");
  })),
  HttpRouter.get("/api/inspect/dossiers/:slug", Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    return yield* inspectEffect("dossiers", params.slug);
  })),
  HttpRouter.get("/api/inspect/dossiers", inspectEffect("dossiers")),
  HttpRouter.get("/api/inspect/:target", Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    return yield* inspectEffect(params.target ?? "");
  })),
).pipe(
  HttpRouter.get("/api/illustration", getIllustrationStatus),
  HttpRouter.post("/api/illustration", postIllustration),
  HttpRouter.post("/api/illustration/pick", postIllustrationPick),
  HttpRouter.post("/api/illustration/cancel", postIllustrationCancel),
  HttpRouter.get("/api/illustrations/:ts", getIllustrationPng),
);
