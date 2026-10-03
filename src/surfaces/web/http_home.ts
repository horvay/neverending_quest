import { HttpRouter, HttpServerResponse } from "@effect/platform";
import { Context, Effect, Layer } from "effect";
import {
  HomeError,
  HomeSurface,
  isHomeError,
  PLAYER_FAILURE,
  type HomeSnapshot,
} from "../../home/index.ts";
import type { LocalModelSelection } from "../../home/types.ts";
import { parseLocalGpuChoice } from "@nq/local-inference/profile.ts";
import type {
  AlmanacSaved,
  AlmanacView,
  ApiError,
  CampaignOpened,
  HomeView,
} from "./api.ts";
import { jsonBody, noContent, requireOrigin, str, type Body } from "./route_kit.ts";
import { playSessionFacade, type PlaySessionApi } from "../../play/session.ts";

export class HomeService extends Context.Tag("nq/Home")<
  HomeService,
  HomeSurface
>() {}

export function homeServiceLayer(
  surface: HomeSurface,
): Layer.Layer<HomeService> {
  return Layer.succeed(HomeService, surface);
}

export function playSessionFromHome(surface: HomeSurface): PlaySessionApi {
  return playSessionFacade(() => surface.play);
}

function homeFail(err: unknown) {
  if (isHomeError(err)) {
    const status =
      err.code === "busy" || err.code === "locked"
        ? 409
        : err.code === "unknown_provider" ||
            err.code === "unknown_pack" ||
            err.code === "unknown_campaign"
          ? 404
          : err.code === "need_sign_in"
            ? 401
            : err.code === "delete_failed"
              ? 500
              : 400;
    return HttpServerResponse.json({ error: err.message, code: err.code } satisfies ApiError, {
      status,
    });
  }
  return HttpServerResponse.json({ error: PLAYER_FAILURE.openFailed } satisfies ApiError, {
    status: 500,
  });
}

/**
 * A state-changing Home route: same-origin, then the body (if any), then the
 * Home surface runs it; a HomeError maps to its status and player copy.
 */
function homeCommand<A>(opts: {
  body?: "json" | "raw";
  run: (home: HomeSurface, body: Body) => Promise<A>;
  respond: (result: A) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
}) {
  return Effect.gen(function* () {
    const denied = yield* requireOrigin;
    if (denied) return denied;
    const home = yield* HomeService;
    const body: Body = opts.body ? yield* jsonBody : {};
    return yield* Effect.tryPromise({
      try: () => opts.run(home, body),
      catch: (err) => err,
    }).pipe(
      Effect.flatMap((result) => opts.respond(result)),
      Effect.catchAll((err) => homeFail(err)),
    );
  });
}

/** Run a Home step, then answer with Home as it is now. */
function homeStep(
  run: (home: HomeSurface, body: Body) => Promise<unknown>,
  opts: { status?: number; body?: "json" | "raw" } = { body: "json" },
) {
  return homeCommand({
    ...(opts.body ? { body: opts.body } : {}),
    run: async (home, body) => {
      await run(home, body);
      return publicSnapshot(await home.snapshot());
    },
    respond: (view) => HttpServerResponse.json(view, { status: opts.status ?? 200 }),
  });
}

const text = (body: Body, key: string): string => str(body, key) ?? "";

const getHome = Effect.gen(function* () {
  const home = yield* HomeService;
  const snap: HomeSnapshot = yield* Effect.tryPromise({
    try: () => home.snapshot(),
    catch: (err) => err,
  });
  return yield* HttpServerResponse.json(publicSnapshot(snap));
});

const postLogin = homeStep(
  async (home, body) => {
    const provider = text(body, "provider");
    if (!provider) throw new HomeError("unknown_provider", "Choose a Provider.");
    await home.startLogin(provider);
  },
  { status: 202, body: "json" },
);

const postLoginCancel = homeStep(async (home) => home.cancelLogin(), {
  status: 202,
});

const postLoginModel = homeStep((home, body) => home.pickModel(text(body, "model")), {
  status: 202,
  body: "json",
});

const postLoginReasoning = homeStep(
  (home, body) => home.pickReasoning(text(body, "reasoning")),
  { status: 202, body: "json" },
);

const postLoginLocal = homeStep(
  (home, local) => {
    const num = (key: string) =>
      typeof local[key] === "number" ? (local[key] as number) : Number.NaN;
    const maybeNum = (key: string) =>
      typeof local[key] === "number" ? (local[key] as number) : undefined;
    const bool = (key: string) =>
      typeof local[key] === "boolean" ? (local[key] as boolean) : undefined;
    return home.pickLocalModel({
      model: text(local, "model"),
      contextTokens: num("contextTokens"),
      reasoningTokens: num("reasoningTokens"),
      mmproj: str(local, "mmproj"),
      cacheK: str(local, "cacheK"),
      cacheV: str(local, "cacheV"),
      // validated in the surface, which owns the knob table
      tuning: local.tuning as LocalModelSelection["tuning"],
      kvOffload: bool("kvOffload"),
      flashAttention: bool("flashAttention"),
      gpu: parseLocalGpuChoice(local.gpu),
      // absent for GGUF models, whose engine has neither knob
      parallel: maybeNum("parallel"),
      ramCacheGiB: maybeNum("ramCacheGiB"),
      reasoning: text(local, "reasoning"),
    });
  },
  { status: 202, body: "json" },
);

const postLoginEngine = homeStep((home, body) =>
  home.downloadLocalEngine(text(body, "backend")),
);

const postLoginPrompt = homeStep((home, body) => home.completePrompt(text(body, "text")));

const opened = (status: number) => (open: { id: string; name: string }) =>
  HttpServerResponse.json({ id: open.id, name: open.name } satisfies CampaignOpened, {
    status,
  });

const postCampaigns = homeCommand({
  body: "json",
  run: (home, body) => home.birthAndOpen(text(body, "pack"), text(body, "title") || undefined),
  respond: opened(201),
});

const postCampaignsOpen = homeCommand({
  body: "json",
  run: (home, body) => home.openById(text(body, "id")),
  respond: opened(200),
});

const postCampaignsDelete = homeCommand({
  body: "json",
  run: (home, body) => home.deleteById(text(body, "id")),
  respond: () => noContent,
});

const postLeave = homeCommand({
  run: (home) => home.leave(),
  respond: () => noContent,
});

const postModelWarm = homeCommand({
  run: async (home) => home.warmModel(),
  respond: () => noContent,
});

const postPlaySettings = homeStep((home, body) => home.updatePlaySettings(body));

const postSettings = homeStep((home, body) => home.updateSettings(body));

const getAlmanac = Effect.gen(function* () {
  const home = yield* HomeService;
  return yield* Effect.tryPromise({
    try: () => home.almanac(),
    catch: (err) => err,
  }).pipe(
    Effect.flatMap((almanac: AlmanacView) => HttpServerResponse.json(almanac)),
    Effect.catchAll((err) => homeFail(err)),
  );
});

const postAlmanacEntry = homeCommand({
  body: "json",
  run: async (home, body): Promise<AlmanacSaved> => {
    const entry = await home.saveAlmanacEntry(body);
    return { entry, almanac: await home.almanac() };
  },
  respond: (saved) => HttpServerResponse.json(saved),
});

const postAlmanacDelete = homeCommand({
  body: "json",
  run: async (home, body): Promise<AlmanacView> => {
    await home.deleteAlmanacEntry(text(body, "id"));
    return home.almanac();
  },
  respond: (almanac) => HttpServerResponse.json(almanac),
});

export function publicSnapshot(snap: HomeSnapshot): HomeView {
  return {
    signedIn: snap.signedIn
      ? {
          provider: snap.signedIn.provider,
          model: snap.signedIn.model,
        }
      : null,
    locked: snap.locked,
    login: {
      phase: snap.login.phase,
      message: snap.login.message,
      allowEmpty: snap.login.allowEmpty,
    },
    providers: {
      featured: snap.providers.featured.map((p) => ({
        name: p.name,
        connected: p.connected === true,
      })),
      more: snap.providers.more.map((p) => ({
        name: p.name,
        connected: p.connected === true,
      })),
    },
    models:
      snap.models?.map((m) => ({
        name: m.name,
        selector: m.selector,
        ...(m.size !== undefined ? { size: m.size } : {}),
        ...(m.mmproj ? { mmproj: m.mmproj } : {}),
        ...(m.sampling ? { sampling: m.sampling } : {}),
        ...(m.identity ? { identity: m.identity } : {}),
        ...(m.engine ? { engine: m.engine } : {}),
      })) ?? null,
    mmproj:
      snap.mmproj?.map((f) => ({
        path: f.path,
        name: f.name,
        ...(f.size !== undefined ? { size: f.size } : {}),
      })) ?? null,
    gpus: snap.gpus
      ? {
          gpus: snap.gpus.gpus.map((gpu) => ({ ...gpu })),
          ...(snap.gpus.primaryBackend ? { primaryBackend: snap.gpus.primaryBackend } : {}),
          downloadable: [...snap.gpus.downloadable],
        }
      : null,
    exl3xpu: snap.exl3xpu ? { ...snap.exl3xpu } : null,
    localProfiles: snap.localProfiles
      ? Object.fromEntries(
          Object.entries(snap.localProfiles).map(([selector, entry]) => [
            selector,
            { profile: { ...entry.profile }, saved: entry.saved },
          ]),
        )
      : null,
    reasoning: snap.reasoning?.map((r) => ({ name: r.name })) ?? null,
    campaigns: snap.campaigns.map((c) => ({ id: c.id, name: c.name })),
    packs: snap.packs.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
    })),
    settings: { ...snap.settings },
    fixedSettings: [...snap.fixedSettings],
    diagnostics: snap.diagnostics,
    choosesGameMaster: snap.choosesGameMaster,
    open: snap.open ? { id: snap.open.id, name: snap.open.name } : null,
  };
}

export const homeHttpApp = HttpRouter.empty.pipe(
  HttpRouter.get("/api/home", getHome),
  HttpRouter.post("/api/login", postLogin),
  HttpRouter.post("/api/login/cancel", postLoginCancel),
  HttpRouter.post("/api/login/model", postLoginModel),
  HttpRouter.post("/api/login/reasoning", postLoginReasoning),
  HttpRouter.post("/api/login/local", postLoginLocal),
  HttpRouter.post("/api/login/prompt", postLoginPrompt),
  HttpRouter.post("/api/login/engine", postLoginEngine),
  HttpRouter.post("/api/campaigns", postCampaigns),
  HttpRouter.post("/api/campaigns/open", postCampaignsOpen),
  HttpRouter.post("/api/campaigns/delete", postCampaignsDelete),
  HttpRouter.post("/api/settings", postSettings),
  HttpRouter.post("/api/settings/play", postPlaySettings),
  HttpRouter.post("/api/leave", postLeave),
  HttpRouter.post("/api/model/warm", postModelWarm),
  HttpRouter.get("/api/almanac", getAlmanac),
  HttpRouter.post("/api/almanac", postAlmanacEntry),
  HttpRouter.post("/api/almanac/delete", postAlmanacDelete),
);
