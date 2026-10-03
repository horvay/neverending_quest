import { afterAll, beforeAll } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { configure } from "@testing-library/dom";
import type { HomeSurface } from "../../src/home/index.ts";
import type { PlayHandle, PlaySessionOptions } from "../../src/play/session.ts";
import type { PlayLoop } from "../../src/play/loop.ts";
import {
  NativeAbortController,
  NativeAbortSignal,
  NativeRequest,
  nativeFetch,
} from "./native_request.ts";

// Bun's own networking classes, captured before any DOM is registered (this
// module is evaluated once per test process, ahead of installDom()).
const NATIVE_NETWORK = {
  fetch: nativeFetch,
  Request: NativeRequest,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  AbortController: NativeAbortController,
  AbortSignal: NativeAbortSignal,
};

/**
 * Bun shares globals across test files in one run, so a DOM left registered
 * by one file replaces Request/fetch for every file after it (happy-dom drops
 * the Host and Origin headers). Each DOM test file installs the DOM itself and
 * removes it again when that file's tests are done.
 */
export function installDom(): void {
  const install = () => {
    if (!GlobalRegistrator.isRegistered) {
      GlobalRegistrator.register({ url: "http://127.0.0.1:7737/" });
    }
    // The DOM is happy-dom's, but networking stays Bun's: servers that run in
    // this process (the Local Inference Host, a fake engine, OMP's provider
    // client) need real Request/Response/fetch, and happy-dom's drop the Host
    // and Origin headers. unregister() puts back what register() replaced.
    Object.assign(globalThis, NATIVE_NETWORK);
  };
  // Now, so the modules this file imports next see a DOM; and again before
  // its tests, because Bun may load this file while the previous DOM file
  // still has its window up, and that file's afterAll then closes it.
  install();
  beforeAll(install);
  // findBy*/waitFor return as soon as the UI is ready; the ceiling only
  // matters on a loaded machine, where the 1s default fails healthy tests.
  configure({ asyncUtilTimeout: 5_000 });
  afterAll(async () => {
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  });
}

/**
 * Report reduced motion, so interfaces skip decorative animation and settle
 * at once, as a player with that preference would see them.
 */
export function preferReducedMotion(): void {
  const apply = () =>
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }),
    });
  apply();
  // after installDom's beforeAll, which may have put up a fresh window
  beforeAll(apply);
}

/*
 * The book's server side, for DOM tests. Everything below is the real `nq
 * serve` stack (routes, Play Session, Play Loop, Home) wired the way
 * src/surfaces/web/serve.ts wires it; only the network hop is skipped. Project
 * modules are imported lazily so they load after `installDom()`.
 */

export const ORIGIN = "http://127.0.0.1:7737";

export type Handler = (req: Request) => Promise<Response>;

/**
 * Route the page's relative fetch() at the in-process HTTP app.
 * Rebuilds each call with Bun's Request so Host/Origin survive (CSRF).
 * Requests to any other origin (OMP's client calling the Local Inference
 * Host, say) go out over the real network stack.
 */
export function installHandlerFetch(handler: Handler): () => void {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(raw, ORIGIN);
    if (url.origin !== ORIGIN) return nativeFetch(input, init);
    const headers = new Headers(init?.headers);
    if (input instanceof Request) {
      input.headers.forEach((value, key) => {
        if (!headers.has(key)) headers.set(key, value);
      });
    }
    headers.set("Host", url.host);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method !== "GET" && method !== "HEAD" && !headers.has("Origin")) {
      headers.set("Origin", ORIGIN);
    }
    let body: BodyInit | undefined;
    if (init?.body != null) {
      body = init.body;
    } else if (
      input instanceof Request &&
      method !== "GET" &&
      method !== "HEAD"
    ) {
      body = await input.text();
    }
    return handler(new NativeRequest(url, { method, headers, body }));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prev;
  };
}

/** Wait until the Play Loop really takes commands again (not just the book). */
export async function waitForLoopIdle(
  loop: PlayLoop,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (loop.loopState !== "idle") {
    if (Date.now() > deadline) {
      throw new Error(`play loop stuck in ${loop.loopState}`);
    }
    await Bun.sleep(2);
  }
}

export type BookServer = {
  readonly handle: PlayHandle;
  readonly loop: PlayLoop;
  readonly handler: Handler;
  /** Wait until the loop is idle (its final commit is done). */
  idle(): Promise<void>;
  close(): Promise<void>;
};

/**
 * `nq serve <campaign>`: the Play Session and its HTTP routes, with the Play
 * Loop in reach so a test can wait on its real state.
 */
export async function serveBook(opts: PlaySessionOptions): Promise<BookServer> {
  const { Effect, Layer } = await import("effect");
  const { HttpApp } = await import("@effect/platform");
  const { closePlayHandle, openPlayHandle, PlaySession } = await import(
    "../../src/play/session.ts"
  );
  const { serveHttpApp } = await import("../../src/surfaces/web/http.ts");
  const handle = await Effect.runPromise(openPlayHandle(opts));
  const boot = HttpApp.toWebHandlerLayer(
    serveHttpApp,
    Layer.succeed(PlaySession, handle.api),
  );
  return {
    handle,
    loop: handle.loop,
    handler: boot.handler,
    idle: () => waitForLoopIdle(handle.loop),
    async close() {
      await boot.dispose();
      await closePlayHandle(handle);
    },
  };
}

export type HomeServer = {
  readonly handler: Handler;
  close(): Promise<void>;
};

/** `nq serve` with Home: Home and book routes over one real HomeSurface. */
export async function serveHome(surface: HomeSurface): Promise<HomeServer> {
  const { Layer } = await import("effect");
  const { HttpApp, HttpRouter } = await import("@effect/platform");
  const { serveHttpApp } = await import("../../src/surfaces/web/http.ts");
  const { homeHttpApp, homeServiceLayer, playSessionFromHome } = await import(
    "../../src/surfaces/web/http_home.ts"
  );
  const { PlaySession } = await import("../../src/play/session.ts");
  const boot = HttpApp.toWebHandlerLayer(
    HttpRouter.concat(homeHttpApp, serveHttpApp),
    Layer.mergeAll(
      Layer.succeed(PlaySession, playSessionFromHome(surface)),
      homeServiceLayer(surface),
    ),
  );
  return {
    handler: boot.handler,
    async close() {
      await boot.dispose();
      await surface.leave();
    },
  };
}

/** A 1×1 PNG: what the (external) image generator leaves on disk. */
const TINY_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/**
 * Stands in for the image generator (Anima / sd-cli is external): paints a
 * sitting file where the Play Loop asks for it. `gate(slot)` may hold a slot.
 */
export function paintSittings(opts: {
  gate?: (slot: number) => Promise<void>;
  painted?: Array<{ prompt: string; slot: number }>;
} = {}): NonNullable<NonNullable<PlaySessionOptions["illustrator"]>["paintOne"]> {
  return async ({ prompt, outPath, slot, signal }) => {
    await opts.gate?.(slot);
    if (signal?.aborted) throw new Error("aborted");
    opts.painted?.push({ prompt, slot });
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, TINY_PNG);
  };
}
