import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Fiber, Layer } from "effect";
import type { HomeSurface } from "../../home/index.ts";
import type { PlayConfig } from "../../play/types.ts";
import { serveHttpApp } from "./http.ts";
import { homeHttpApp, homeServiceLayer, playSessionFromHome } from "./http_home.ts";
import { PlaySession } from "../../play/session.ts";

export type WebAssets = {
  html: string;
  css: string;
  js: string;
};

const WATCH_CLIENT = `<script>
(() => {
  let gen = 0;
  const poll = async () => {
    try {
      const res = await fetch("/__watch?since=" + gen, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const next = Number(body.gen);
      if (gen !== 0 && next !== gen) {
        location.reload();
        return;
      }
      gen = next;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
    poll();
  };
  poll();
})();
</script>`;

export function withWatchClient(html: string): string {
  if (html.includes("/__watch")) return html;
  if (html.includes("</body>")) return html.replace("</body>", `${WATCH_CLIENT}\n</body>`);
  return `${html}\n${WATCH_CLIENT}\n`;
}

export function watchEnabled(): boolean {
  return process.env.NQ_WATCH === "1";
}

export async function buildWebAssets(): Promise<WebAssets> {
  const dir = path.join(import.meta.dir, "client");
  const html = await readFile(path.join(dir, "index.html"), "utf8");
  const bookCss = await readFile(path.join(dir, "book.css"), "utf8");
  const diceCssHref = import.meta.resolve("@gnuton/css-dice-roller/style.css");
  const diceCss = await readFile(new URL(diceCssHref), "utf8");
  const css = `${bookCss}\n${diceCss}`;
  const built = await Bun.build({
    entrypoints: [path.join(dir, "client.tsx")],
    target: "browser",
    format: "esm",
    minify: false,
  });
  if (!built.success) {
    throw new Error(
      built.logs.map((l) => String(l)).join("\n") || "web bundle failed",
    );
  }
  const js = await built.outputs[0]!.text();
  return { html, css, js };
}

type LiveAssets = {
  get: () => WebAssets;
  gen: () => number;
  wait: (since: number) => Promise<number>;
  stop: () => void;
};

export function createLiveAssets(initial: WebAssets): LiveAssets {
  let current: WebAssets = {
    ...initial,
    html: withWatchClient(initial.html),
  };
  let gen = Date.now();
  const waiters = new Set<(n: number) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let building = false;
  let again = false;

  const bump = (next: WebAssets) => {
    current = { ...next, html: withWatchClient(next.html) };
    gen += 1;
    for (const wake of waiters) wake(gen);
    waiters.clear();
  };

  const rebuild = async () => {
    if (building) {
      again = true;
      return;
    }
    building = true;
    try {
      bump(await buildWebAssets());
      console.log("[watch] rebuilt book assets");
    } catch (err) {
      console.error(
        "[watch] rebuild failed:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      building = false;
      if (again) {
        again = false;
        void rebuild();
      }
    }
  };

  const dir = path.join(import.meta.dir, "client");
  const watcher = watch(dir, { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void rebuild();
    }, 80);
  });

  return {
    get: () => current,
    gen: () => gen,
    wait: (since) => {
      if (gen !== since) return Promise.resolve(gen);
      return new Promise((resolve) => {
        const wake = (n: number) => resolve(n);
        waiters.add(wake);
        setTimeout(() => {
          waiters.delete(wake);
          resolve(gen);
        }, 25_000);
      });
    },
    stop: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
      waiters.clear();
    },
  };
}

export function serveAppWithAssets(assets: WebAssets) {
  return attachWebAssets(serveHttpApp, () => assets);
}

const DICE_ASSET_DIR = path.join(import.meta.dir, "client", "dice");
const DICE_ASSETS: Record<string, string> = {
  "banner.png": "image/png",
  "ring.png": "image/png",
};
const INK_ASSET_DIR = path.join(import.meta.dir, "client", "ink");
const INK_ASSETS: Record<string, string> = {
  "well.png": "image/png",
  "desk.jpg": "image/jpeg",
  "brush.png": "image/png",
  "easel.png": "image/png",
  "studio-easel.png": "image/png",
  "paper.jpg": "image/jpeg",
  "leather.jpg": "image/jpeg",
  "frontispiece.webp": "image/webp",
  "vignette.webp": "image/webp",
  "compass.webp": "image/webp",
  "corner.webp": "image/webp",
  "fleuron.webp": "image/webp",
  "seal.webp": "image/webp",
};

function serveNamedPng(
  route: "/dice/:name" | "/ink/:name",
  dir: string,
  allow: Record<string, string>,
) {
  return HttpRouter.get(
    route,
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const name = params.name ?? "";
      const contentType = allow[name];
      if (!contentType) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(path.join(dir, name)),
        catch: () => new Error("missing asset"),
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (!bytes) return HttpServerResponse.empty({ status: 404 });
      return HttpServerResponse.uint8Array(bytes, { contentType });
    }),
  );
}

function serveDiceAsset() {
  return serveNamedPng("/dice/:name", DICE_ASSET_DIR, DICE_ASSETS);
}

function serveInkAsset() {
  return serveNamedPng("/ink/:name", INK_ASSET_DIR, INK_ASSETS);
}

export function attachWebAssets<E, R>(
  api: HttpRouter.HttpRouter<E, R>,
  getAssets: () => WebAssets,
  live?: LiveAssets,
) {
  if (!live) {
    const assets = getAssets();
    return api.pipe(
      serveDiceAsset(),
      serveInkAsset(),
      HttpRouter.get(
        "/book.css",
        HttpServerResponse.text(assets.css, { contentType: "text/css" }),
      ),
      HttpRouter.get(
        "/app.js",
        HttpServerResponse.text(assets.js, {
          contentType: "application/javascript",
        }),
      ),
      HttpRouter.get("/", HttpServerResponse.html(assets.html)),
      // an adventure's address loads the book, which opens it
      HttpRouter.get("/play/*", HttpServerResponse.html(assets.html)),
    );
  }
  const noStore = { "cache-control": "no-store" };
  return api.pipe(
    serveDiceAsset(),
    serveInkAsset(),
    HttpRouter.get(
      "/book.css",
      Effect.suspend(() =>
        HttpServerResponse.text(getAssets().css, {
          contentType: "text/css",
          headers: noStore,
        }),
      ),
    ),
    HttpRouter.get(
      "/app.js",
      Effect.suspend(() =>
        HttpServerResponse.text(getAssets().js, {
          contentType: "application/javascript",
          headers: noStore,
        }),
      ),
    ),
    HttpRouter.get(
      "/",
      Effect.suspend(() => HttpServerResponse.html(getAssets().html)),
    ),
    HttpRouter.get(
      "/play/*",
      Effect.suspend(() => HttpServerResponse.html(getAssets().html)),
    ),
    HttpRouter.get(
      "/__watch",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(req.url, "http://127.0.0.1");
        const since = Number(url.searchParams.get("since") ?? "0");
        const gen = yield* Effect.promise(() => live.wait(since));
        return yield* HttpServerResponse.json({ gen }, { headers: noStore });
      }),
    ),
  );
}

async function prepareAssets(): Promise<{
  get: () => WebAssets;
  live?: LiveAssets;
}> {
  const built = await buildWebAssets();
  if (!watchEnabled()) return { get: () => built };
  const live = createLiveAssets(built);
  console.log("watching src/surfaces/web/client — save to reload the book");
  return { get: live.get, live };
}

/**
 * Serve until the process ends (Ctrl+C / kill), or until `signal` aborts for
 * an in-process caller.
 */
async function launchUntil<A, E>(
  live: Layer.Layer<A, E, never>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    BunRuntime.runMain(Layer.launch(live));
    // Block until Ctrl+C / process kill — do not return or cli.ts process.exit
    // will tear the listener down immediately.
    await new Promise<never>(() => {});
    return;
  }
  const fiber = Effect.runFork(Layer.launch(live));
  if (!signal.aborted) {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
  await Effect.runPromise(Fiber.interrupt(fiber));
}

/**
 * URLs the serve page is reachable at. Loopback first (used for --open); when
 * bound to every interface, each non-internal IPv4 address follows so a phone
 * on the LAN has something to type.
 */
export function serveUrls(config: { serveHost: string; servePort: number }): string[] {
  const port = config.servePort;
  if (config.serveHost !== "0.0.0.0" && config.serveHost !== "::") {
    return [`http://${config.serveHost}:${port}/`];
  }
  const out = [`http://127.0.0.1:${port}/`];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      out.push(`http://${a.address}:${port}/`);
    }
  }
  return out;
}

/** Serve the book (Home, then play) until the process ends or `signal` aborts. */
export async function runServe(
  surface: HomeSurface,
  opts: {
    path?: string;
    config: PlayConfig & { servePort: number; serveHost: string };
    openBrowser?: boolean;
    /** Stops the server; without it, serve runs until the process ends. */
    signal?: AbortSignal;
  },
): Promise<number> {
  try {
    await surface.refreshLocal();
    if (opts.path) await surface.openPath(opts.path);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let prepared: { get: () => WebAssets; live?: LiveAssets };
  try {
    prepared = await prepareAssets();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const routes = HttpRouter.concat(homeHttpApp, serveHttpApp);
  const book = prepared.live
    ? attachWebAssets(routes, prepared.get, prepared.live)
    : attachWebAssets(routes, prepared.get);
  const app = book.pipe(HttpServer.serve(), HttpServer.withLogAddress);
  const session = Layer.succeed(PlaySession, playSessionFromHome(surface));
  const home = homeServiceLayer(surface);
  const server = BunHttpServer.layer({
    port: opts.config.servePort,
    hostname: opts.config.serveHost,
    idleTimeout: 0,
  });

  const url = serveUrls(opts.config)[0]!;
  const snap = await surface.snapshot();
  if (snap.open) {
    console.log(`${snap.open.name} · ${snap.open.path}`);
  }
  for (const line of serveUrls(opts.config)) console.log(line);
  if (opts.openBrowser) {
    await Bun.$`xdg-open ${url}`.quiet().nothrow();
  }

  const live = Layer.provide(app, Layer.mergeAll(server, session, home));
  await launchUntil(live, opts.signal);
  return 0;
}
